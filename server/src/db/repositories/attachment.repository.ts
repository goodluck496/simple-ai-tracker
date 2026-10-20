import type { SqlDatabase } from '../sql-database.js';
import type { AttachmentRepository, NewAttachment } from '../../domain/ports.js';
import type { PlanRevision, TaskAttachment } from '../../domain/entities.js';
import { mapAttachment, type AttachmentRow } from '../rows.js';

export class SqliteAttachmentRepository implements AttachmentRepository {
  public constructor(private readonly db: SqlDatabase) {}

  /**
   * Добавляет вложение. Для kind='plan' выполняется версионирование:
   * предыдущий актуальный план помечается is_current = 0, новый получает version + 1.
   * Так в карточке всегда хранится полная история планов (от чего шли и к чему пришли).
   */
  public add(attachment: NewAttachment): TaskAttachment {
    return this.db.transaction(() => {
      let version = 1;

      if (attachment.kind === 'plan') {
        const previous = this.db
          .prepare(
            `SELECT COALESCE(MAX(version), 0) AS max_version FROM task_attachments WHERE task_id = ? AND kind = 'plan'`,
          )
          .get<{ max_version: number }>([attachment.taskId]);
        version = (previous?.max_version ?? 0) + 1;
        this.db
          .prepare(`UPDATE task_attachments SET is_current = 0 WHERE task_id = ? AND kind = 'plan'`)
          .run([attachment.taskId]);
      }

      const result = this.db
        .prepare(
          `INSERT INTO task_attachments (task_id, name, kind, version, is_current, content, source_path, size, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run([
          attachment.taskId,
          attachment.name,
          attachment.kind,
          version,
          attachment.content,
          attachment.sourcePath,
          attachment.size,
          attachment.createdAt,
        ]);

      const row = this.db
        .prepare('SELECT * FROM task_attachments WHERE id = ?')
        .get<AttachmentRow>([result.lastInsertRowId]);
      if (!row) throw new Error('Не удалось сохранить вложение');
      return mapAttachment(row);
    });
  }

  public listByTask(taskId: string): TaskAttachment[] {
    return this.db
      .prepare('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all<AttachmentRow>([taskId])
      .map(mapAttachment);
  }

  public currentPlan(taskId: string): TaskAttachment | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_attachments WHERE task_id = ? AND kind = 'plan' AND is_current = 1 ORDER BY version DESC LIMIT 1`,
      )
      .get<AttachmentRow>([taskId]);
    return row ? mapAttachment(row) : null;
  }

  public planHistory(taskId: string): PlanRevision[] {
    return this.db
      .prepare(`SELECT * FROM task_attachments WHERE task_id = ? AND kind = 'plan' ORDER BY version ASC`)
      .all<AttachmentRow>([taskId])
      .map((row) => ({
        attachmentId: row.id,
        name: row.name,
        version: row.version,
        isCurrent: row.is_current === 1,
        size: row.size,
        sourcePath: row.source_path,
        createdAt: row.created_at,
      }));
  }

  public removeAttachment(attachmentId: number): boolean {
    const result = this.db.prepare('DELETE FROM task_attachments WHERE id = ?').run([attachmentId]);
    return result.changes > 0;
  }

  public countByTask(taskId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM task_attachments WHERE task_id = ?')
      .get<{ total: number }>([taskId]);
    return row?.total ?? 0;
  }
}
