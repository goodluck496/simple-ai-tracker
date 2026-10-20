import type { SqlDatabase } from '../sql-database.js';
import type { LinkRepository, NewLink } from '../../domain/ports.js';
import type { LinkRelation, TaskLink } from '../../domain/entities.js';
import { mapLink, type LinkRow } from '../rows.js';

export class SqliteLinkRepository implements LinkRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public add(link: NewLink): TaskLink {
    this.db
      .prepare('INSERT OR IGNORE INTO task_links (task_id, linked_task_id, relation, created_at) VALUES (?, ?, ?, ?)')
      .run([link.taskId, link.linkedTaskId, link.relation, link.createdAt]);

    const row = this.db
      .prepare('SELECT * FROM task_links WHERE task_id = ? AND linked_task_id = ? AND relation = ?')
      .get<LinkRow>([link.taskId, link.linkedTaskId, link.relation]);
    if (!row) throw new Error('Не удалось сохранить связь');
    return mapLink(row);
  }

  public remove(taskId: string, linkedTaskId: string, relation?: LinkRelation): number {
    if (relation) {
      const result = this.db
        .prepare('DELETE FROM task_links WHERE task_id = ? AND linked_task_id = ? AND relation = ?')
        .run([taskId, linkedTaskId, relation]);
      return result.changes;
    }
    const result = this.db
      .prepare('DELETE FROM task_links WHERE task_id = ? AND linked_task_id = ?')
      .run([taskId, linkedTaskId]);
    return result.changes;
  }

  public listByTask(taskId: string): TaskLink[] {
    return this.db
      .prepare('SELECT * FROM task_links WHERE task_id = ? ORDER BY id ASC')
      .all<LinkRow>([taskId])
      .map(mapLink);
  }

  public listIncoming(taskId: string): TaskLink[] {
    return this.db
      .prepare('SELECT * FROM task_links WHERE linked_task_id = ? ORDER BY id ASC')
      .all<LinkRow>([taskId])
      .map(mapLink);
  }
}
