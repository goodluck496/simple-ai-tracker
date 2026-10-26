import path from 'node:path';
import { loadConfig, type TrackerConfig } from '../core/config.js';
import { StderrLogger, type Logger } from '../core/logger.js';
import { WorkspaceManager, type ActiveContainer } from '../core/workspace-manager.js';
import type { SqlDatabase } from '../db/sql-database.js';
import type { Repositories } from '../domain/ports.js';
import { TaskService, type Clock } from '../services/task-service.js';
import { ContextService } from '../services/context-service.js';
import { TagService } from '../services/tag-service.js';
import { InstructionsService } from '../services/instructions-service.js';
import { VerificationService } from '../services/verification-service.js';
import { BackupService } from '../services/backup-service.js';
import { ImageService } from '../services/image-service.js';
import type { AutomationService } from '../automation/automation-service.js';

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
  readonly automationService: AutomationService;
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
  /** WorkspaceManager — переключение между пространствами. */
  readonly workspaceManager: WorkspaceManager;
  close(): void;
}

export function createContainer(options: ContainerOptions = {}): AppContainer {
  const logger = options.logger ?? new StderrLogger('tracker');
  const baseConfig = loadConfig(options.config ?? {});

  const manager = new WorkspaceManager(baseConfig, logger, options);

  return {
    get automationService() { return manager.active.automationService; },
    get config() { return manager.active.config; },
    logger,
    get db() { return manager.active.db; },
    get repos() { return manager.active.repos; },
    get taskService() { return manager.active.taskService; },
    get contextService() { return manager.active.contextService; },
    get tagService() { return manager.active.tagService; },
    get instructionsService() { return manager.active.instructionsService; },
    get verificationService() { return manager.active.verificationService; },
    get backupService() { return manager.active.backupService; },
    get imageService() { return manager.active.imageService; },
    workspaceManager: manager,
    close: () => manager.close(),
  };
}

/** Путь к файлу БД по умолчанию (для сообщений CLI и логов). */
export function defaultDatabasePath(config: TrackerConfig): string {
  return path.resolve(config.dbPath);
}
