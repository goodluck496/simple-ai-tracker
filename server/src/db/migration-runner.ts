import type { Logger } from '../core/logger.js';
import type { SqlDatabase } from './sql-database.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations/index.js';

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/** Применяет неприменённые миграции схемы. Идемпотентно. */
export class MigrationRunner {
  public constructor(
    private readonly db: SqlDatabase,
    private readonly logger?: Logger,
    private readonly migrations: readonly Migration[] = MIGRATIONS,
  ) {}

  public run(): MigrationResult {
    const from = this.db.getSchemaVersion();
    const pending = [...this.migrations]
      .filter((migration) => migration.version > from)
      .sort((a, b) => a.version - b.version);

    const applied: string[] = [];
    for (const migration of pending) {
      const changed = this.db.transaction(() => {
        // Another API/MCP process may have migrated while this process waited for the write lock.
        if (this.db.getSchemaVersion() >= migration.version) return false;
        this.db.exec(migration.sql);
        this.db.setSchemaVersion(migration.version);
        return true;
      });
      if (!changed) continue;
      applied.push(`${String(migration.version).padStart(3, '0')}-${migration.name}`);
      this.logger?.info('Применена миграция схемы', { version: migration.version, name: migration.name });
    }

    const to = this.db.getSchemaVersion();
    return { from, to, applied };
  }

  public get latestVersion(): number {
    return LATEST_SCHEMA_VERSION;
  }
}
