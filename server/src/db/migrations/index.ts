import { name as name001, sql as sql001, version as version001 } from './001-initial.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Реестр миграций. Порядок строго по возрастанию version.
 * Новая миграция = новый файл + запись в этом массиве.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: version001, name: name001, sql: sql001 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
