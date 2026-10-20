import type { SqlDatabase } from '../sql-database.js';
import type { MetaRepository } from '../../domain/ports.js';

export class SqliteMetaRepository implements MetaRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM tracker_meta WHERE key = ?').get<{ value: string }>([key]);
    return row?.value ?? null;
  }

  public set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO tracker_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run([key, value]);
  }

  public all(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM tracker_meta ORDER BY key ASC').all<{
      key: string;
      value: string;
    }>();
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }
}
