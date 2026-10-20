import type { SqlDatabase } from '../sql-database.js';
import type { SearchIndex } from '../../domain/ports.js';
import { SEARCHABLE_COLUMNS, type SearchableColumn, type SearchScope } from '../../domain/entities.js';

const MAX_TOKENS = 8;
const MIN_TOKEN_LENGTH = 2;

/**
 * Полнотекстовый индекс (FTS5) по заголовку, описанию, комментариям и тегам.
 * Индекс поддерживается явно при каждой записи — это дешевле и надёжнее
 * триггеров при агрегации комментариев.
 *
 * Поиск поддерживает мультивыбор полей: `['title', 'description']` ищет по обоим,
 * `['all']` (или пустой набор) — по всем колонкам плюс по ID карточки.
 */
export class SqliteSearchIndex implements SearchIndex {
  public constructor(private readonly db: SqlDatabase) {}

  public reindexTask(taskId: string): void {
    const task = this.db
      .prepare('SELECT id, title, description FROM tasks WHERE id = ?')
      .get<{ id: string; title: string; description: string }>([taskId]);
    if (!task) return;

    const comments = this.db
      .prepare(
        `SELECT group_concat(text, ' ') AS body FROM (
           SELECT text FROM task_comments WHERE task_id = ? ORDER BY id ASC
         )`,
      )
      .get<{ body: string | null }>([taskId]);
    const tags = this.db
      .prepare(
        `SELECT group_concat(g.name, ' ') AS body FROM task_tags tt
         JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = ?`,
      )
      .get<{ body: string | null }>([taskId]);

    this.db.prepare('DELETE FROM task_search WHERE task_id = ?').run([taskId]);
    this.db
      .prepare('INSERT INTO task_search (task_id, title, description, comments, tags) VALUES (?, ?, ?, ?, ?)')
      .run([taskId, task.title, task.description, comments?.body ?? '', tags?.body ?? '']);
  }

  public removeTask(taskId: string): void {
    this.db.prepare('DELETE FROM task_search WHERE task_id = ?').run([taskId]);
  }

  public search(query: string, scopes: readonly SearchScope[] | SearchScope, limit = 50): string[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));

    const selected = normalizeScopes(scopes);
    const includeAll = selected.includes('all');
    const columns: SearchableColumn[] = includeAll
      ? [...SEARCHABLE_COLUMNS]
      : selected.filter((scope): scope is SearchableColumn =>
          (SEARCHABLE_COLUMNS as readonly string[]).includes(scope),
        );
    const includeId = includeAll || selected.includes('id');

    const ids: string[] = [];
    const seen = new Set<string>();
    const push = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    const matchExpression = buildMatchExpression(trimmed, columns);
    if (matchExpression) {
      const rows = this.db
        .prepare(`SELECT task_id FROM task_search WHERE task_search MATCH ? ORDER BY rank, task_id LIMIT ?`)
        .all<{ task_id: string }>([matchExpression, safeLimit]);
      for (const row of rows) push(row.task_id);
    }

    // ID не участвует в FTS (колонка UNINDEXED) — ищем подстрокой.
    if (includeId) {
      for (const id of this.searchById(trimmed, safeLimit)) push(id);
    }

    // Подстрочный fallback: FTS не находит части слов и короткие запросы.
    if (ids.length < safeLimit) {
      for (const id of this.searchBySubstring(trimmed, safeLimit, columns, includeId)) push(id);
    }

    return ids.slice(0, safeLimit);
  }

  public rebuildAll(): number {
    const ids = this.db.prepare('SELECT id FROM tasks ORDER BY seq ASC').all<{ id: string }>();
    this.db.prepare('DELETE FROM task_search').run();
    for (const row of ids) this.reindexTask(row.id);
    return ids.length;
  }

  private searchById(query: string, limit: number): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE id LIKE ? ORDER BY seq ASC LIMIT ?`)
      .all<{ id: string }>([`%${query.toUpperCase()}%`, limit]);
    return rows.map((row) => row.id);
  }

  private searchBySubstring(
    query: string,
    limit: number,
    columns: readonly SearchableColumn[],
    includeId: boolean,
  ): string[] {
    const like = `%${query.toLowerCase()}%`;
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (columns.includes('title')) {
      conditions.push('lower(t.title) LIKE ?');
      params.push(like);
    }
    if (columns.includes('description')) {
      conditions.push('lower(t.description) LIKE ?');
      params.push(like);
    }
    if (columns.includes('comments')) {
      conditions.push(
        'EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND lower(c.text) LIKE ?)',
      );
      params.push(like);
    }
    if (columns.includes('tags')) {
      conditions.push(
        'EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND lower(g.name) LIKE ?)',
      );
      params.push(like);
    }
    if (includeId) {
      conditions.push('lower(t.id) LIKE ?');
      params.push(like);
    }
    if (conditions.length === 0) return [];

    params.push(limit);
    return this.db
      .prepare(`SELECT t.id FROM tasks t WHERE ${conditions.join(' OR ')} ORDER BY t.seq ASC LIMIT ?`)
      .all<{ id: string }>(params)
      .map((row) => row.id);
  }
}

/** Приводит входные области поиска к плоскому списку без дублей. */
export function normalizeScopes(scopes: readonly SearchScope[] | SearchScope | undefined): SearchScope[] {
  const list = Array.isArray(scopes) ? scopes : scopes ? [scopes] : [];
  const unique = [...new Set(list)];
  return unique.length > 0 ? unique : ['all'];
}

/**
 * Собирает FTS5-выражение: каждый токен ищется во всех выбранных колонках (OR),
 * токены объединяются по AND — как в обычном поиске по нескольким полям.
 */
export function buildMatchExpression(query: string, columns: readonly SearchableColumn[]): string | null {
  if (columns.length === 0) return null;

  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
    .slice(0, MAX_TOKENS);
  if (tokens.length === 0) return null;

  const tokenExpressions = tokens.map((token) => {
    const quoted = `"${token.replace(/"/g, '""')}"*`;
    if (columns.length === SEARCHABLE_COLUMNS.length) return quoted;
    const perColumn = columns.map((column) => `${column} : ${quoted}`);
    return `(${perColumn.join(' OR ')})`;
  });

  return tokenExpressions.join(' AND ');
}
