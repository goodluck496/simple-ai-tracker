import fs from 'node:fs';
import path from 'node:path';
import type { TrackerConfig } from '../core/config.js';
import { TrackerError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { SqlDatabase } from '../db/sql-database.js';
import { systemClock, type Clock } from './task-service.js';

export interface BackupRecord {
  /** Имя файла бэкапа внутри каталога бэкапов. */
  readonly name: string;
  /** Абсолютный путь. */
  readonly path: string;
  readonly size: number;
  readonly createdAt: string;
}

export interface RestoreResult {
  readonly restoredFrom: string;
  readonly preRestoreBackup: string;
  readonly dbPath: string;
}

const BACKUP_FILE_PATTERN = /^[A-Za-z0-9._-]+\.db$/;
const TIMESTAMP_SAFE = /[-:]/g;

/**
 * Резервное копирование базы трекера.
 *
 * Снимок делается через `VACUUM INTO` на живой базе: файл целостный, без WAL/SHM,
 * сервер останавливать не нужно. Ротация ограничивает число копий, чтобы каталог
 * `data/backups` не рос бесконечно.
 */
export class BackupService {
  public constructor(
    private readonly config: TrackerConfig,
    private readonly db: SqlDatabase,
    private readonly clock: Clock = systemClock,
    private readonly logger?: Logger,
  ) {}

  public get directory(): string {
    return this.config.backupDir;
  }

  public ensureDirectory(): void {
    fs.mkdirSync(this.config.backupDir, { recursive: true });
  }

  /** Создаёт новый бэкап и возвращает его описание. */
  public create(reason = 'manual'): BackupRecord {
    this.ensureDirectory();
    const name = `tracker-${this.timestamp()}.db`;
    const target = path.join(this.config.backupDir, name);

    this.db.backupTo(target);

    const stat = fs.statSync(target);
    this.logger?.info('Создан бэкап базы', { name, size: stat.size, reason });
    return {
      name,
      path: target,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
    };
  }

  /** Список бэкапов, новые сверху. */
  public list(): BackupRecord[] {
    if (!fs.existsSync(this.config.backupDir)) return [];
    return fs
      .readdirSync(this.config.backupDir)
      .filter((file) => BACKUP_FILE_PATTERN.test(file))
      .map((file) => {
        const absolute = path.join(this.config.backupDir, file);
        const stat = fs.statSync(absolute);
        return { name: file, path: absolute, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public find(name: string): BackupRecord | null {
    if (!BACKUP_FILE_PATTERN.test(name)) return null;
    const absolute = path.join(this.config.backupDir, name);
    if (!fs.existsSync(absolute)) return null;
    const stat = fs.statSync(absolute);
    return { name, path: absolute, size: stat.size, createdAt: stat.mtime.toISOString() };
  }

  /** Требует существующий бэкап (защита от обхода каталога небезопасным именем). */
  public require(name: string): BackupRecord {
    if (!BACKUP_FILE_PATTERN.test(name)) {
      throw new TrackerError('VALIDATION_FAILED', `Недопустимое имя бэкапа: "${name}".`);
    }
    const record = this.find(name);
    if (!record) {
      throw new TrackerError('TASK_NOT_FOUND', `Бэкап "${name}" не найден.`, { backupDir: this.config.backupDir });
    }
    return record;
  }

  public remove(name: string): boolean {
    const record = this.find(name);
    if (!record) return false;
    fs.rmSync(record.path, { force: true });
    this.logger?.info('Бэкап удалён', { name });
    return true;
  }

  /** Оставляет только `keep` последних бэкапов, возвращает число удалённых. */
  public prune(keep: number): number {
    if (!Number.isFinite(keep) || keep <= 0) return 0;
    const backups = this.list();
    const stale = backups.slice(keep);
    for (const backup of stale) fs.rmSync(backup.path, { force: true });
    if (stale.length > 0) this.logger?.info('Ротация бэкапов', { removed: stale.length, keep });
    return stale.length;
  }

  /**
   * Восстановление базы из бэкапа.
   *
   * ВАЖНО: вызывать только при остановленном сервере (через CLI). Если передано
   * соединение, оно закрывается перед подменой файла — иначе открытая БД
   * продолжит работать со старым файлом. Перед заменой создаётся снимок текущего
   * состояния (`pre-restore`), чтобы откат был обратим.
   */
  public restore(name: string, options: { readonly connection?: { close(): void } } = {}): RestoreResult {
    const source = this.require(name);
    const preRestore = this.create('pre-restore');
    options.connection?.close();
    this.swapDatabaseFile(source);

    this.logger?.warn('База восстановлена из бэкапа', { from: source.name, dbPath: this.config.dbPath });
    return { restoredFrom: source.name, preRestoreBackup: preRestore.name, dbPath: this.config.dbPath };
  }

  /** Подменяет файл базы копией бэкапа (только при закрытом соединении). */
  public swapDatabaseFile(source: BackupRecord): void {
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${this.config.dbPath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
    }
    fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
    fs.copyFileSync(source.path, this.config.dbPath);
  }

  /** Метка времени для имени файла: 2026-10-19_15-04-12. */
  private timestamp(): string {
    const iso = this.clock.now().replace('Z', '');
    const [datePart = 'unknown-date', timePart = '00-00-00'] = iso.split('T');
    const withoutMillis = timePart.split('.')[0].replace(/:/g, '-');
    return `${datePart}_${withoutMillis}`;
  }
}
