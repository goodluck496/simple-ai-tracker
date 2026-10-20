import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqlDatabase, SqlDatabaseFactory, SqlDatabaseOptions, SqlRunResult, SqlStatement, SqlValue } from './sql-database.js';

/**
 * Реализация SqlDatabase на встроенном в Node драйвере node:sqlite.
 * Без внешних зависимостей и нативной сборки — важно для переносимости проекта.
 */
export class NodeSqliteDatabase implements SqlDatabase, SqlDatabaseFactory {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;
  private closed = false;

  public constructor(options: SqlDatabaseOptions) {
    if (options.file !== ':memory:') {
      fs.mkdirSync(path.dirname(options.file), { recursive: true });
    }
    this.db = new DatabaseSync(options.file, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
    });
    if (!options.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
    }
  }

  public open(options: SqlDatabaseOptions): SqlDatabase {
    return new NodeSqliteDatabase(options);
  }

  public get location(): string {
    return this.db.isOpen ? 'node:sqlite' : 'closed';
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public prepare(sql: string): SqlStatement {
    const cached = this.statements.get(sql);
    const statement = cached ?? this.db.prepare(sql);
    if (!cached) this.statements.set(sql, statement);

    return {
      run: (params?: readonly SqlValue[]): SqlRunResult => {
        const result = params && params.length > 0 ? statement.run(...params) : statement.run();
        return {
          changes: Number(result.changes),
          lastInsertRowId: Number(result.lastInsertRowid),
        };
      },
      get: <T>(params?: readonly SqlValue[]): T | undefined => {
        const row = params && params.length > 0 ? statement.get(...params) : statement.get();
        return row as T | undefined;
      },
      all: <T>(params?: readonly SqlValue[]): T[] => {
        const rows = params && params.length > 0 ? statement.all(...params) : statement.all();
        return rows as T[];
      },
    };
  }

  public transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Транзакция могла быть уже закрыта драйвером; исходную ошибку не теряем.
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  public backupTo(targetPath: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    // VACUUM INTO создаёт целостный снимок одной операцией: не требует остановки
    // сервера, не копирует WAL/SHM и уважает незакоммиченные транзакции как снимок.
    // SQLite требует, чтобы файла назначения не существовало.
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
    this.db.prepare('VACUUM INTO ?').run(targetPath);
  }

  public getSchemaVersion(): number {
    const row = this.prepare('PRAGMA user_version').get<{ user_version: number }>();
    return row ? Number(row.user_version) : 0;
  }

  public setSchemaVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`Некорректная версия схемы: ${version}`);
    }
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  public close(): void {
    if (this.closed) return;
    this.statements.clear();
    this.db.close();
    this.closed = true;
  }
}
