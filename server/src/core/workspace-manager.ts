import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadConfig, type TrackerConfig } from './config.js';
import type { Logger } from './logger.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { MigrationRunner } from '../db/migration-runner.js';
import { createRepositories } from '../db/repositories/index.js';
import type { SqlDatabase } from '../db/sql-database.js';
import type { Repositories } from '../domain/ports.js';
import { TaskService, systemClock } from '../services/task-service.js';
import { ContextService } from '../services/context-service.js';
import { TagService } from '../services/tag-service.js';
import { InstructionsService } from '../services/instructions-service.js';
import { VerificationService } from '../services/verification-service.js';
import { BackupService } from '../services/backup-service.js';
import { ImageService } from '../services/image-service.js';
import { TrackerError } from './errors.js';
import type { ContainerOptions } from '../bootstrap/container.js';
import { AutomationService } from '../automation/automation-service.js';
import { AgentRunRepository } from '../automation/run-repository.js';

/** Одно пространство: имя, файл БД, каталог бэкапов. */
export interface WorkspaceInfo {
  readonly name: string;
  readonly label: string;
  readonly createdAt: string;
  readonly dbPath: string;
  readonly backupDir: string;
}

/** Реестр пространств — хранится в data/workspaces.json. */
interface WorkspaceRegistry {
  workspaces: WorkspaceInfo[];
  current: string;
}

const REGISTRY_FILENAME = 'workspaces.json';
const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,49}$/i;

/**
 * WorkspaceManager — переключает активную БД на лету,
 * не требуя рестарта сервера. Каждое пространство — отдельный файл SQLite.
 *
 * Архитектура: manager владеет "текущим контейнером" и может
 * пересобрать его при смене пространства, сохранив HTTP-сервер.
 */
export class WorkspaceManager {
  private registry: WorkspaceRegistry;
  private activeContainer: ActiveContainer;
  private readonly scope = new AsyncLocalStorage<ActiveContainer>();
  private readonly containers = new Map<string, ActiveContainer>();
  private readonly dataDir: string;
  private readonly appRoot: string;
  private readonly baseConfig: TrackerConfig;
  private readonly logger: Logger;

  constructor(config: TrackerConfig, logger: Logger, private readonly options: ContainerOptions = {}) {
    this.dataDir = path.join(config.appRoot, 'data');
    this.appRoot = config.appRoot;
    this.baseConfig = config;
    this.logger = logger;

    // Ensure data directory exists
    if (config.dbPath !== ':memory:') fs.mkdirSync(this.dataDir, { recursive: true });

    this.registry = this.loadRegistry();
    this.registry.current = config.dbPath === ':memory:' ? 'default' : process.env.SAT_WORKSPACE ?? 'default';
    if (!this.registry.workspaces.some((workspace) => workspace.name === this.registry.current)) {
      throw new TrackerError('WORKSPACE_NOT_FOUND', 'Configured SAT_WORKSPACE does not exist.');
    }
    this.activeContainer = this.buildContainer(this.registry.current);
    this.containers.set(this.registry.current, this.activeContainer);
  }

  /** Текущее активное пространство. */
  get currentName(): string {
    return this.registry.current;
  }

  /** Текущий контейнер (службы + БД). */
  get active(): ActiveContainer {
    return this.scope.getStore() ?? this.activeContainer;
  }

  /** Pin an asynchronous request to one workspace for its entire lifetime. */
  public within<T>(name: string, action: () => T): T {
    this.get(name);
    let container = this.containers.get(name);
    if (!container) {
      container = this.buildContainer(name);
      this.containers.set(name, container);
    }
    return this.scope.run(container, action);
  }

  /** Список всех пространств. */
  list(): WorkspaceInfo[] {
    this.refreshRegistry();
    return [...this.registry.workspaces];
  }

  /** Получить информацию о конкретном пространстве. */
  get(name: string): WorkspaceInfo {
    this.refreshRegistry();
    const ws = this.registry.workspaces.find((w) => w.name === name);
    if (!ws) throw new TrackerError('WORKSPACE_NOT_FOUND', `Пространство "${name}" не найдено.`);
    return ws;
  }

  /** Создать новое пространство (БД создаётся при первом обращении). */
  create(name: string, label?: string): WorkspaceInfo {
    this.refreshRegistry();
    if (typeof name !== 'string' || (label !== undefined && typeof label !== 'string')) {
      throw new TrackerError('VALIDATION_FAILED', 'Workspace name and label must be strings.');
    }
    const normalizedName = this.normalizeName(name);
    if (this.registry.workspaces.some((w) => w.name === normalizedName)) {
      throw new TrackerError('WORKSPACE_EXISTS', `Пространство "${normalizedName}" уже существует.`);
    }

    const ws: WorkspaceInfo = {
      name: normalizedName,
      label: label?.trim() || normalizedName,
      createdAt: new Date().toISOString(),
      dbPath: path.join(this.dataDir, `${normalizedName}.db`),
      backupDir: path.join(this.dataDir, normalizedName, 'backups'),
    };

    if (fs.existsSync(ws.dbPath)) {
      throw new TrackerError('CONFLICT', 'Workspace files already exist; choose another name.');
    }

    // Create the DB file immediately (runs migrations)
    this.openWorkspaceDb(ws);
    this.registry.workspaces.push(ws);
    this.saveRegistry();

    this.logger.info('Пространство создано', { name: normalizedName, db: ws.dbPath });
    return ws;
  }

  /** Переключить активное пространство. */
  activate(name: string): WorkspaceInfo {
    const ws = this.get(name);
    if (name === this.registry.current) return ws;

    this.logger.info('Переключение пространства', { from: this.registry.current, to: name });

    const next = this.containers.get(name) ?? this.buildContainer(name);
    this.containers.set(name, next);
    this.registry.current = name;
    this.saveRegistry();
    this.activeContainer = next;

    return ws;
  }

  /** Удалить пространство (нельзя удалить текущее или default). */
  remove(name: string): void {
    if (name === 'default') {
      throw new TrackerError('WORKSPACE_PROTECTED', 'Пространство "default" нельзя удалить.');
    }
    if (name === this.registry.current) {
      throw new TrackerError('WORKSPACE_ACTIVE', 'Невозможно удалить активное пространство. Сначала переключитесь на другое.');
    }
    this.get(name); // throws if not found
    if (this.containers.has(name)) {
      throw new TrackerError('CONFLICT', 'Workspace is open. Restart the service before removing it.');
    }

    this.registry.workspaces = this.registry.workspaces.filter((w) => w.name !== name);
    this.saveRegistry();

    this.logger.info('Пространство удалено', { name });
  }

  /** Пересобрать текущий контейнер (например, после смену workspace извне). */
  rebuild(): void {
    this.activeContainer.close();
    this.activeContainer = this.buildContainer(this.registry.current);
    this.containers.set(this.registry.current, this.activeContainer);
  }

  close(): void {
    for (const container of this.containers.values()) container.close();
    this.containers.clear();
  }

  // ──────────────────────────────────────────────

  private normalizeName(name: string): string {
    const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!WORKSPACE_NAME_RE.test(trimmed)) {
      throw new TrackerError('VALIDATION_FAILED', 'Имя пространства: 1-50 символов, латиница, цифры, дефис, подчёркивание. Не может начинаться со спецсимвола.');
    }
    return trimmed;
  }

  private dbPathFor(workspaceName: string): string {
    // "default" → data/tracker.db (legacy compatibility)
    if (workspaceName === 'default') {
      return this.baseConfig.dbPath;
    }
    return path.join(this.dataDir, `${workspaceName}.db`);
  }

  private backupDirFor(workspaceName: string): string {
    if (workspaceName === 'default') {
      return this.baseConfig.backupDir;
    }
    return path.join(this.dataDir, workspaceName, 'backups');
  }

  /** Open the workspace DB (creates file + runs migrations if needed). */
  private openWorkspaceDb(ws: WorkspaceInfo): void {
    const db = new NodeSqliteDatabase({ file: ws.dbPath });
    new MigrationRunner(db, this.logger).run();
    db.close();
  }

  /** Build all services against a specific workspace's DB. */
  private buildContainer(workspaceName: string): ActiveContainer {
    const dbPath = this.dbPathFor(workspaceName);
    const backupDir = this.backupDirFor(workspaceName);

    const config: TrackerConfig = {
      ...this.baseConfig,
      dbPath,
      backupDir,
      imagesDir: workspaceName === 'default' ? this.baseConfig.imagesDir : path.join(this.dataDir, workspaceName, 'images'),
    };

    const db = workspaceName === 'default' && this.options.db
      ? this.options.db : new NodeSqliteDatabase({ file: config.dbPath });
    if (!this.options.skipMigrations) new MigrationRunner(db, this.logger).run();

    const repos = createRepositories(db);

    // Preserve ID prefix per workspace
    const storedPrefix = repos.meta.get('id_prefix');
    const finalConfig = storedPrefix ? { ...config, idPrefix: storedPrefix } : config;
    if (!storedPrefix) {
      repos.meta.set('id_prefix', this.baseConfig.idPrefix);
    }
    if (!repos.meta.get('created_at')) {
      repos.meta.set('created_at', systemClock.now());
    }

    const clock = this.options.clock ?? systemClock;
    const taskService = new TaskService({ config: finalConfig, repos, clock, logger: this.logger, searchIndexing: this.options.searchIndexing });
    const contextService = new ContextService(taskService);
    const tagService = new TagService(repos, clock);
    const instructionsService = new InstructionsService(this.appRoot, this.logger);
    const verificationService = new VerificationService(finalConfig, repos, taskService);
    const backupService = new BackupService(finalConfig, db, clock, this.logger);
    const imageService = new ImageService(finalConfig, this.logger);
    const automationService = new AutomationService(new AgentRunRepository(db), repos, taskService, clock, workspaceName);

    return {
      config: finalConfig,
      db,
      repos,
      taskService,
      contextService,
      tagService,
      instructionsService,
      verificationService,
      backupService,
      imageService,
      automationService,
      close: () => db.close(),
    };
  }

  private registryPath(): string {
    return path.join(this.dataDir, REGISTRY_FILENAME);
  }

  private refreshRegistry(): void {
    if (this.baseConfig.dbPath === ':memory:') return;
    const current = this.registry.current;
    this.registry = this.loadRegistry();
    this.registry.current = current;
  }

  private loadRegistry(): WorkspaceRegistry {
    const filePath = this.registryPath();
    if (this.baseConfig.dbPath !== ':memory:' && fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkspaceRegistry;
        if (raw.workspaces?.length && raw.current) return raw;
      } catch {
        throw new TrackerError('INTERNAL', 'Cannot read workspace registry; refusing to replace existing project configuration.');
      }
      throw new TrackerError('INTERNAL', 'Invalid workspace registry; refusing to replace existing project configuration.');
    }

    // Bootstrap: create "default" workspace
    const defaultWs: WorkspaceInfo = {
      name: 'default',
      label: 'Default',
      createdAt: new Date().toISOString(),
      dbPath: this.baseConfig.dbPath,
      backupDir: this.baseConfig.backupDir,
    };

    const registry: WorkspaceRegistry = { workspaces: [defaultWs], current: 'default' };
    this.saveRegistry(registry);
    return registry;
  }

  private saveRegistry(registry?: WorkspaceRegistry): void {
    if (this.baseConfig.dbPath === ':memory:') return;
    const data = registry ?? this.registry;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temporary = `${this.registryPath()}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(temporary, this.registryPath());
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/** Активный контейнер пространств: все сервисы + БД, собранные на лету. */
export interface ActiveContainer {
  readonly automationService: AutomationService;
  readonly config: TrackerConfig;
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
