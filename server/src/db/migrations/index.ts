import { name as name001, sql as sql001, version as version001 } from './001-initial.js';
import { name as name002, sql as sql002, version as version002 } from './002-automation.js';

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
  { version: version002, name: name002, sql: sql002 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
