import type { SqlDatabase } from '../sql-database.js';
import type { EventRepository, NewEvent } from '../../domain/ports.js';
import type { TaskEvent } from '../../domain/entities.js';
import { mapEvent, type EventRow } from '../rows.js';

export class SqliteEventRepository implements EventRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public add(event: NewEvent): TaskEvent {
    const result = this.db
      .prepare('INSERT INTO task_events (task_id, type, actor, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run([
        event.taskId,
        event.type,
        event.actor,
        event.summary,
        JSON.stringify(event.payload ?? {}),
        event.createdAt,
      ]);

    const row = this.db.prepare('SELECT * FROM task_events WHERE id = ?').get<EventRow>([result.lastInsertRowId]);
    if (!row) throw new Error('Не удалось сохранить событие');
    return mapEvent(row);
  }

  public listByTask(taskId: string, limit?: number): TaskEvent[] {
    if (limit && limit > 0) {
      const rows = this.db
        .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all<EventRow>([taskId, Math.trunc(limit)]);
      return rows.reverse().map(mapEvent);
    }
    return this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all<EventRow>([taskId])
      .map(mapEvent);
  }
}
