import path from 'node:path';
import { loadConfig, type TrackerConfig } from '../core/config.js';
import { StderrLogger, type Logger } from '../core/logger.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { MigrationRunner } from '../db/migration-runner.js';
import { createRepositories } from '../db/repositories/index.js';
import type { SqlDatabase } from '../db/sql-database.js';
import type { Repositories } from '../domain/ports.js';
import { TaskService, systemClock, type Clock } from '../services/task-service.js';
import { ContextService } from '../services/context-service.js';
import { TagService } from '../services/tag-service.js';
import { InstructionsService } from '../services/instructions-service.js';
import { VerificationService } from '../services/verification-service.js';
import { BackupService } from '../services/backup-service.js';
import { ImageService } from '../services/image-service.js';

export interface ContainerOptions {
  readonly config?: Partial<TrackerConfig>;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Готовое соединение (для тестов на ':memory:'). */
  readonly db?: SqlDatabase;
  readonly searchIndexing?: boolean;
  readonly skipMigrations?: boolean;
}

/** Зависимости приложения: собираются один раз и переиспользуются транспортами. */
export interface AppContainer {
  readonly config: TrackerConfig;
  readonly logger: Logger;
  readonly db: SqlDatabase;
  readonly repos: Repositories;
  readonly taskService: TaskService;
  readonly contextService: ContextService;
  readonly tagService: TagService;
  readonly instructionsService: InstructionsService;
  readonly verificationService: VerificationService;
  readonly backupService: BackupService;
  readonly imageService: ImageService;
  close(): void;
}

export function createContainer(options: ContainerOptions = {}): AppContainer {
  const logger = options.logger ?? new StderrLogger('tracker');
  const baseConfig = loadConfig(options.config ?? {});
  const db = options.db ?? new NodeSqliteDatabase({ file: baseConfig.dbPath });

  if (!options.skipMigrations) {
    new MigrationRunner(db, logger).run();
  }

  const repos = createRepositories(db);

  // Префикс ID фиксируется в БД при первом запуске: импорт legacy-задач
  // сохраняет исторические префиксы (MS-…), новые задачи получают актуальный.
  const storedPrefix = repos.meta.get('id_prefix');
  let config = baseConfig;
  if (storedPrefix) {
    config = { ...baseConfig, idPrefix: storedPrefix };
  } else {
    repos.meta.set('id_prefix', baseConfig.idPrefix);
  }
  if (!repos.meta.get('created_at')) {
    repos.meta.set('created_at', systemClock.now());
  }

  const clock = options.clock ?? systemClock;
  const taskService = new TaskService({
    config,
    repos,
    clock,
    logger,
    searchIndexing: options.searchIndexing,
  });
  const contextService = new ContextService(taskService);
  const tagService = new TagService(repos, clock);
  const instructionsService = new InstructionsService(config.appRoot, logger);
  const verificationService = new VerificationService(config, repos, taskService);
  const backupService = new BackupService(config, db, clock, logger);
  const imageService = new ImageService(config, logger);

  return {
    config,
    logger,
    db,
    repos,
    taskService,
    contextService,
    tagService,
    instructionsService,
    verificationService,
    backupService,
    imageService,
    close: () => db.close(),
  };
}

/** Путь к файлу БД по умолчанию (для сообщений CLI и логов). */
export function defaultDatabasePath(config: TrackerConfig): string {
  return path.resolve(config.dbPath);
}
