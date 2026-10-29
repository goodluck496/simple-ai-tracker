import type { SqlDatabase } from '../sql-database.js';
import type { CreateTaskRecord, TaskPatch, TaskQueryRepository, TaskRepository } from '../../domain/ports.js';
import type { Task } from '../../domain/entities.js';
import type { TaskStatus } from '../../domain/task-status.js';
import type { TaskFilters } from '../../domain/entities.js';
import { mapSummary, mapTask, type SummaryRow, type TagRow, type TaskRow } from '../rows.js';
import { mapTag } from '../rows.js';
import type { Tag } from '../../domain/entities.js';

const SUMMARY_SELECT = `
  SELECT
    t.id, t.seq, t.title, t.description, t.type, t.status, t.parent_id,
    t.position, t.requires_manual_test, t.trusted_execution, t.created_at, t.updated_at,
    (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments_count,
    (SELECT COUNT(*) FROM task_images i WHERE i.task_id = t.id) AS images_count,
    (SELECT COUNT(*) FROM task_attachments a WHERE a.task_id = t.id) AS attachments_count,
    (SELECT COUNT(*) FROM task_questions q WHERE q.task_id = t.id) AS questions_count,
    (SELECT COUNT(*) FROM task_questions q WHERE q.task_id = t.id AND (q.answer IS NULL OR TRIM(q.answer) = '')) AS open_questions_count,
    (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id) AS subtasks_count,
    (SELECT MAX(a.version) FROM task_attachments a WHERE a.task_id = t.id AND a.kind = 'plan') AS plan_version
  FROM tasks t
`;

/** Запись задач: единственное место, где меняется таблица tasks. */
export class SqliteTaskRepository implements TaskRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public findById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get<TaskRow>([id]);
    return row ? mapTask(row) : null;
  }

  public exists(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM tasks WHERE id = ?').get<{ found: number }>([id]));
  }

  public insert(record: CreateTaskRecord): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, seq, title, description, type, status, parent_id, position, requires_manual_test, trusted_execution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        record.id,
        record.seq,
        record.title,
        record.description,
        record.type,
        record.status,
        record.parentId,
        record.position,
        record.requiresManualTest ? 1 : 0,
        record.trustedExecution ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      ]);
    const created = this.findById(record.id);
    if (!created) throw new Error(`Не удалось создать задачу ${record.id}`);
    return created;
  }

  public update(id: string, patch: TaskPatch): Task | null {
    const assignments: string[] = [];
    const params: Array<string | number | null> = [];

    const push = (column: string, value: string | number | null): void => {
      assignments.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.title !== undefined) push('title', patch.title);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.type !== undefined) push('type', patch.type);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.parentId !== undefined) push('parent_id', patch.parentId);
    if (patch.position !== undefined) push('position', patch.position);
    if (patch.trustedExecution !== undefined) push('trusted_execution', patch.trustedExecution ? 1 : 0);
    if (patch.requiresManualTest !== undefined) push('requires_manual_test', patch.requiresManualTest ? 1 : 0);
    push('updated_at', patch.updatedAt);

    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?`).run(params);
    return this.findById(id);
  }

  public delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run([id]);
    return result.changes > 0;
  }

  public nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM tasks').get<{ max_seq: number }>();
    return (row?.max_seq ?? 0) + 1;
  }

  public maxPosition(status: TaskStatus): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(position), 0) AS max_position FROM tasks WHERE status = ?')
      .get<{ max_position: number }>([status]);
    return row?.max_position ?? 0;
  }

  public listPositionsInStatus(status: TaskStatus): readonly { readonly id: string; readonly position: number }[] {
    return this.db
      .prepare('SELECT id, position FROM tasks WHERE status = ? ORDER BY position ASC, seq ASC')
      .all<{ id: string; position: number }>([status]);
  }
}

/** Чтение агрегированных карточек (канбан, списки, поиск). */
export class SqliteTaskQueryRepository implements TaskQueryRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public listSummaries(filters: TaskFilters): ReturnType<TaskQueryRepository['listSummaries']> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filters.status) {
      conditions.push('t.status = ?');
      params.push(filters.status);
    }
    if (filters.type) {
      conditions.push('t.type = ?');
      params.push(filters.type);
    }
    if (filters.parentId !== undefined && filters.parentId !== null) {
      conditions.push('t.parent_id = ?');
      params.push(filters.parentId);
    }
    if (filters.tag) {
      conditions.push(
        'EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND g.name = ?)',
      );
      params.push(filters.tag.trim().toLowerCase());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters.limit && filters.limit > 0 ? `LIMIT ${Math.trunc(filters.limit)}` : '';
    const rows = this.db
      .prepare(`${SUMMARY_SELECT} ${where} ORDER BY t.position ASC, t.seq ASC ${limitClause}`)
      .all<SummaryRow>(params);

    return this.attachTags(rows);
  }

  public listSummariesByIds(ids: readonly string[]): ReturnType<TaskQueryRepository['listSummaries']> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(`${SUMMARY_SELECT} WHERE t.id IN (${placeholders})`).all<SummaryRow>([...ids]);
    const summaries = this.attachTags(rows);
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    return ids.map((id) => byId.get(id)).filter((summary): summary is NonNullable<typeof summary> => Boolean(summary));
  }

  public getSummary(id: string): ReturnType<TaskQueryRepository['getSummary']> {
    const rows = this.db.prepare(`${SUMMARY_SELECT} WHERE t.id = ?`).all<SummaryRow>([id]);
    const [summary] = this.attachTags(rows);
    return summary ?? null;
  }

  public countByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS total FROM tasks GROUP BY status').all<{
      status: string;
      total: number;
    }>();
    const result: Record<string, number> = {};
    for (const row of rows) result[row.status] = row.total;
    return result;
  }

  private attachTags(rows: readonly SummaryRow[]): ReturnType<TaskQueryRepository['listSummaries']> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    const tagRows = this.db
      .prepare(
        `SELECT tt.task_id AS task_id, g.id, g.name, g.color, g.description, g.created_at
         FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
         WHERE tt.task_id IN (${placeholders})
         ORDER BY g.name ASC`,
      )
      .all<TagRow & { task_id: string }>([...ids]);

    const tagsByTask = new Map<string, Tag[]>();
    for (const row of tagRows) {
      const list = tagsByTask.get(row.task_id) ?? [];
      list.push(mapTag(row));
      tagsByTask.set(row.task_id, list);
    }

    return rows.map((row) => mapSummary(row, tagsByTask.get(row.id) ?? []));
  }
}
