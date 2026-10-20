import type { SqlDatabase } from '../sql-database.js';
import type { CommentRepository, NewComment } from '../../domain/ports.js';
import type { TaskComment } from '../../domain/entities.js';
import { mapComment, type CommentRow } from '../rows.js';

export class SqliteCommentRepository implements CommentRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public add(comment: NewComment): TaskComment {
    const result = this.db
      .prepare('INSERT INTO task_comments (task_id, author, text, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run([comment.taskId, comment.author, comment.text, comment.kind, comment.createdAt]);

    const row = this.db.prepare('SELECT * FROM task_comments WHERE id = ?').get<CommentRow>([result.lastInsertRowId]);
    if (!row) throw new Error('Не удалось сохранить комментарий');
    return mapComment(row);
  }

  public listByTask(taskId: string, limit?: number): TaskComment[] {
    if (limit && limit > 0) {
      // Последние N комментариев в хронологическом порядке.
      const rows = this.db
        .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all<CommentRow>([taskId, Math.trunc(limit)]);
      return rows.reverse().map(mapComment);
    }
    return this.db
      .prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all<CommentRow>([taskId])
      .map(mapComment);
  }

  public countByTask(taskId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM task_comments WHERE task_id = ?')
      .get<{ total: number }>([taskId]);
    return row?.total ?? 0;
  }
}
