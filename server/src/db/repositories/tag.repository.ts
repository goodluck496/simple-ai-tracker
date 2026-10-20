import type { SqlDatabase } from '../sql-database.js';
import type { TagRepository } from '../../domain/ports.js';
import type { Tag, TagWithStats } from '../../domain/entities.js';
import { mapTag, type TagRow } from '../rows.js';

const TAG_PALETTE = ['#38bdf8', '#a855f7', '#22c55e', '#eab308', '#f97316', '#ec4899', '#06b6d4', '#10b981', '#6366f1', '#f43f5e'];

/** Детерминированный цвет тега по имени — стабильно между запусками. */
export function generateTagColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}

export class SqliteTagRepository implements TagRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public listAll(): Tag[] {
    return this.db.prepare('SELECT * FROM tags ORDER BY name ASC').all<TagRow>().map(mapTag);
  }

  public listWithStats(): TagWithStats[] {
    return this.db
      .prepare(
        `SELECT g.id, g.name, g.color, g.description, g.created_at,
                (SELECT COUNT(*) FROM task_tags tt WHERE tt.tag_id = g.id) AS tasks_count
         FROM tags g ORDER BY g.name ASC`,
      )
      .all<TagRow & { tasks_count: number }>()
      .map((row) => ({ ...mapTag(row), tasksCount: row.tasks_count }));
  }

  public findByName(name: string): Tag | null {
    const row = this.db.prepare('SELECT * FROM tags WHERE name = ?').get<TagRow>([name.trim().toLowerCase()]);
    return row ? mapTag(row) : null;
  }

  public upsert(name: string, color: string, description: string, createdAt: string): Tag {
    const normalized = name.trim().toLowerCase();
    const existing = this.findByName(normalized);
    if (existing) {
      const nextColor = color || existing.color;
      const nextDescription = description || existing.description;
      this.db
        .prepare('UPDATE tags SET color = ?, description = ? WHERE id = ?')
        .run([nextColor, nextDescription, existing.id]);
      return { ...existing, color: nextColor, description: nextDescription };
    }

    const result = this.db
      .prepare('INSERT INTO tags (name, color, description, created_at) VALUES (?, ?, ?, ?)')
      .run([normalized, color || generateTagColor(normalized), description, createdAt]);
    const row = this.db.prepare('SELECT * FROM tags WHERE id = ?').get<TagRow>([result.lastInsertRowId]);
    if (!row) throw new Error('Не удалось сохранить тег');
    return mapTag(row);
  }

  public update(id: number, patch: { color?: string; description?: string }): Tag | null {
    const existing = this.db.prepare('SELECT * FROM tags WHERE id = ?').get<TagRow>([id]);
    if (!existing) return null;
    this.db
      .prepare('UPDATE tags SET color = ?, description = ? WHERE id = ?')
      .run([patch.color ?? existing.color, patch.description ?? existing.description, id]);
    const row = this.db.prepare('SELECT * FROM tags WHERE id = ?').get<TagRow>([id]);
    return row ? mapTag(row) : null;
  }

  public removeByName(name: string): boolean {
    const result = this.db.prepare('DELETE FROM tags WHERE name = ?').run([name.trim().toLowerCase()]);
    return result.changes > 0;
  }

  public attachToTask(taskId: string, tagId: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)')
      .run([taskId, tagId]);
  }

  public detachFromTask(taskId: string, tagId: number): void {
    this.db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?').run([taskId, tagId]);
  }

  public replaceTaskTags(taskId: string, tagIds: readonly number[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run([taskId]);
      for (const tagId of tagIds) {
        this.db.prepare('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)').run([taskId, tagId]);
      }
    });
  }

  public listByTask(taskId: string): Tag[] {
    return this.db
      .prepare(
        `SELECT g.* FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = ? ORDER BY g.name ASC`,
      )
      .all<TagRow>([taskId])
      .map(mapTag);
  }

  public listByTasks(taskIds: readonly string[]): Map<string, Tag[]> {
    const result = new Map<string, Tag[]>();
    if (taskIds.length === 0) return result;
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT tt.task_id AS task_id, g.* FROM task_tags tt
         JOIN tags g ON g.id = tt.tag_id
         WHERE tt.task_id IN (${placeholders}) ORDER BY g.name ASC`,
      )
      .all<TagRow & { task_id: string }>([...taskIds]);

    for (const row of rows) {
      const list = result.get(row.task_id) ?? [];
      list.push(mapTag(row));
      result.set(row.task_id, list);
    }
    return result;
  }
}
