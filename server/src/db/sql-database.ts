/**
 * Абстракция над SQLite-драйвером.
 *
 * Домен, репозитории и сервисы работают только с этими интерфейсами, поэтому
 * драйвер можно заменить (node:sqlite → better-sqlite3 → libsql) без правок
 * бизнес-логики: достаточно реализовать SqlDatabase и передать его в контейнер.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
}

export interface SqlStatement {
  run(params?: readonly SqlValue[]): SqlRunResult;
  get<T>(params?: readonly SqlValue[]): T | undefined;
  all<T>(params?: readonly SqlValue[]): T[];
}

export interface SqlDatabase {
  /** Выполняет один или несколько SQL-стейтментов без параметров (DDL, PRAGMA). */
  exec(sql: string): void;
  /** Готовит запрос (реализации кэшируют подготовленные стейтменты). */
  prepare(sql: string): SqlStatement;
  /** Выполняет функцию в транзакции; вложенные вызовы переиспользуют внешнюю. */
  transaction<T>(fn: () => T): T;
  /**
   * Создаёт консистентный снимок базы в отдельный файл.
   * Работает на «живой» базе: снимок атомарный, без WAL-сайдкаров и без остановки сервера.
   */
  backupTo(targetPath: string): void;
  /** Текущая версия схемы (PRAGMA user_version). */
  getSchemaVersion(): number;
  /** Устанавливает версию схемы (PRAGMA user_version). */
  setSchemaVersion(version: number): void;
  /** Путь к файлу БД или ':memory:'. */
  readonly location: string;
  close(): void;
}

export interface SqlDatabaseOptions {
  /** Путь к файлу БД или ':memory:'. */
  readonly file: string;
  /** Только чтение (для экспорта/аудита). */
  readonly readOnly?: boolean;
}

export interface SqlDatabaseFactory {
  open(options: SqlDatabaseOptions): SqlDatabase;
}
