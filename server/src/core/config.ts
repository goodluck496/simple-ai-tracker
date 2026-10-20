import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Конфигурация приложения Simple AI Tracker.
 *
 * Все пути разрешаются относительно корня приложения (каталог, содержащий
 * package.json и AGENT_INSTRUCTIONS.md), поэтому одинаково работают и в
 * standalone-репозитории, и внутри монорепозитория, и в собранном бандле.
 */
export interface TrackerConfig {
  /** Абсолютный путь к корню приложения. */
  readonly appRoot: string;
  /** Абсолютный путь к файлу SQLite. */
  readonly dbPath: string;
  /** Каталог со собранным веб-клиентом (dist/web/browser). */
  readonly webDistDir: string;
  /** Каталог для бэкапов БД. */
  readonly backupDir: string;
  /** Каталог для скриншотов карточек. */
  readonly imagesDir: string;
  /** Порт HTTP API + UI. */
  readonly httpPort: number;
  /** Хост HTTP API + UI. */
  readonly httpHost: string;
  /** Префикс ID для новых задач (SAT-1, SAT-2, ...). */
  readonly idPrefix: string;
  /** Автоматические бэкапы при старте и по расписанию. */
  readonly backupEnabled: boolean;
  /** Интервал автоматических бэкапов в часах. */
  readonly backupIntervalHours: number;
  /** Максимум автоматических бэкапов за сутки (0 — без ограничения). */
  readonly backupMaxPerDay: number;
  /** Сколько последних бэкапов хранить (остальные удаляются ротацией). */
  readonly backupKeep: number;
}

const DEFAULT_PORT = 4317;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ID_PREFIX = 'SAT';
const DEFAULT_BACKUP_INTERVAL_HOURS = 12;
const DEFAULT_BACKUP_MAX_PER_DAY = 2;
const DEFAULT_BACKUP_KEEP = 20;

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

/**
 * Ищет корень приложения, поднимаясь от текущего модуля вверх.
 * Критерий: наличие package.json и AGENT_INSTRUCTIONS.md.
 */
export function findAppRoot(startDir?: string): string {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const hasPackage = fs.existsSync(path.join(dir, 'package.json'));
    const hasInstructions = fs.existsSync(path.join(dir, 'AGENT_INSTRUCTIONS.md'));
    if (hasPackage && hasInstructions) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  const appRoot = overrides.appRoot ?? process.env.SAT_HOME ?? findAppRoot();
  const dbPath = overrides.dbPath ?? process.env.SAT_DB_PATH ?? path.join(appRoot, 'data', 'tracker.db');

  return {
    appRoot,
    dbPath,
    webDistDir: overrides.webDistDir ?? path.join(appRoot, 'dist', 'web', 'browser'),
    backupDir: overrides.backupDir ?? path.join(appRoot, 'data', 'backups'),
    imagesDir: overrides.imagesDir ?? path.join(appRoot, 'data', 'images'),
    httpPort: overrides.httpPort ?? parseInteger(process.env.SAT_PORT, DEFAULT_PORT),
    httpHost: overrides.httpHost ?? process.env.SAT_HOST ?? DEFAULT_HOST,
    idPrefix: overrides.idPrefix ?? process.env.SAT_ID_PREFIX ?? DEFAULT_ID_PREFIX,
    backupEnabled: overrides.backupEnabled ?? parseBoolean(process.env.SAT_BACKUP_ENABLED, true),
    backupIntervalHours:
      overrides.backupIntervalHours ?? parseInteger(process.env.SAT_BACKUP_INTERVAL_HOURS, DEFAULT_BACKUP_INTERVAL_HOURS),
    backupMaxPerDay:
      overrides.backupMaxPerDay ?? parseInteger(process.env.SAT_BACKUP_MAX_PER_DAY, DEFAULT_BACKUP_MAX_PER_DAY),
    backupKeep: overrides.backupKeep ?? parseInteger(process.env.SAT_BACKUP_KEEP, DEFAULT_BACKUP_KEEP),
  };
}
