import type { SqlDatabase } from '../sql-database.js';
import type { ImageRepository } from '../../domain/ports.js';
import type { TaskImage } from '../../domain/entities.js';
import { mapImage, type ImageRow } from '../rows.js';

export class SqliteImageRepository implements ImageRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public add(taskId: string, url: string, createdAt: string): TaskImage {
    const result = this.db
      .prepare('INSERT INTO task_images (task_id, url, created_at) VALUES (?, ?, ?)')
      .run([taskId, url, createdAt]);
    const row = this.db.prepare('SELECT * FROM task_images WHERE id = ?').get<ImageRow>([result.lastInsertRowId]);
    if (!row) throw new Error('Не удалось сохранить изображение');
    return mapImage(row);
  }

  public replaceForTask(taskId: string, urls: readonly string[], createdAt: string): TaskImage[] {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_images WHERE task_id = ?').run([taskId]);
      for (const url of urls) {
        if (url && url.trim()) this.add(taskId, url.trim(), createdAt);
      }
      return this.listByTask(taskId);
    });
  }

  public listByTask(taskId: string): TaskImage[] {
    return this.db
      .prepare('SELECT * FROM task_images WHERE task_id = ? ORDER BY id ASC')
      .all<ImageRow>([taskId])
      .map(mapImage);
  }
}
