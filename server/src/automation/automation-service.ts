import { TaskRouting, type AcceptanceResult } from '../../../shared/automation/task-routing.js';
import { PipelineDoctor } from './pipeline-doctor.js';
import { ProviderKind, type ProposedFix } from '../../../shared/automation/contracts.js';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { COMMENT_SCREENSHOT, SCREENSHOT_LIMIT, SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_ENCODED_LENGTH, SCREENSHOT_PATH } from '../../../shared/automation/screenshots.js';
import { AgentRole, RunStatus, AgentVerdict, AUTOMATION_START_TASK_STATUSES, ACTIVE_RUN_STATUSES,
  RESUMABLE_RUN_STATUSES, OWNED_RUN_STATUSES, WRITABLE_AGENT_ROLES, EVIDENCE_AGENT_ROLES, AGENT_VERDICTS, AUTOMATION_TIMING, MergePolicy,
  type AgentOutcome, type AgentRun, type AutomationSettings, type IntegrationInfo } from '../../../shared/automation/contracts.js';
import { TaskStatus } from '../../../shared/tasks/status.js';
import type { Repositories } from '../domain/ports.js';
import type { TaskCard } from '../domain/entities.js';
import type { Clock, TaskService } from '../services/task-service.js';
import { TrackerError } from '../core/errors.js';
import { AutomationSettingsValidator } from './settings.js';
import { AgentRunRepository } from './run-repository.js';
import { ProjectRequests } from './project-requests.js';
import { RunPhase, RUN_PHASES, RunProgressText, type QueueItem, type QueueSnapshot } from '../../../shared/automation/queue.js';
import { TokenMeter, type TokenUsage, type UsageAttempt } from '../../../shared/automation/token-usage.js';
import { RunBudget, RUN_BUDGET_FIELDS } from '../../../shared/automation/budget.js';
import { Decomposition } from '../../../shared/automation/decomposition.js';
import { FeaturePlanning } from './feature-planning.js';
import { PipelinePolicy } from '../../../shared/automation/pipeline-policy.js';
import { BATCH_TASK_LIMIT } from '../../../shared/automation/batch.js';
import { StageNotes, type StageMemory } from '../../../shared/automation/stage-note.js';
import { ProjectAction, isProjectScript, type ProjectResult } from '../../../shared/automation/project.js';
import type { CheckExecution, ImprovementPeriod } from '../../../shared/automation/improvement-metrics.js';
import { checkBelongsToRun, checkFingerprint } from './check-evidence.js';
import { collectMetrics, verifyRefs } from './improvement-metrics.js';
import { ImprovementService } from './improvement-service.js';
import { configuredCheckScripts } from './package-manager.js';
import type { SkillLibrary } from './skill-library.js';
import type { ProjectTeamSettings } from './base-team.js';

const LEASE_MS = AUTOMATION_TIMING.leaseMs;

export class AutomationService {
  private readonly doctor = new PipelineDoctor();
  public get projects(): ProjectRequests { return new ProjectRequests(this.repos.meta, this.runs.db); }
  public constructor(private readonly runs: AgentRunRepository, private readonly repos: Repositories,
    private readonly tasks: TaskService, private readonly clock: Clock, private readonly workspace = 'default',
    private readonly images: import('../services/image-service.js').ImageService | undefined,
    private readonly improvements: ImprovementService,
    public readonly skillLibrary: SkillLibrary,
    public readonly projectTeam: ProjectTeamSettings) {}

  public settings(): AutomationSettings {
    return this.projectTeam.read().settings;
  }
  public requestProjectScript(path: unknown, script: unknown) {
    const repositoryPath = this.settings().repositoryPath;
    if (!repositoryPath.trim() || path !== repositoryPath) {
      throw new TrackerError('VALIDATION_FAILED', 'Сохраните путь к проекту перед запуском команды.');
    }
    if (!isProjectScript(script)) throw new TrackerError('VALIDATION_FAILED', 'Выберите скрипт build или deploy.');
    return this.projects.enqueue({ action: ProjectAction.RunScript, path: repositoryPath, script }, true);
  }
  private validateSettings(input: unknown): AutomationSettings {
    const settings = new AutomationSettingsValidator().validate(input);
    if (settings.skillBindings?.length) this.skillLibrary.versions(settings.skillBindings);
    return settings;
  }
  public configure(input: unknown, revision?: unknown, adopt = false): AutomationSettings {
    const settings = this.validateSettings(input);
    this.projectTeam.save(settings, revision, adopt);
    return settings;
  }
  public publishTeam(input: unknown, revision: unknown) {
    return this.projectTeam.publish(this.validateSettings(input), revision);
  }
  public taskTeam(id: string, input?: unknown) {
    this.tasks.getTaskCard(id);
    const key = `automation_task_team_v1:${id}`;
    if (input !== undefined) {
      if (input === null) this.repos.meta.set(key, 'null');
      else {
        const value = input as Partial<AutomationSettings>;
        const checked = new AutomationSettingsValidator().validate({
          ...this.settings(),
          ...(value.agents ? { agents: value.agents } : {}),
          ...(value.pipeline ? { pipeline: value.pipeline } : {}),
          pipelineRoutes: value.pipelineRoutes ?? [],
          ...(value.routingProfileIds !== undefined ? {routingProfileIds: value.routingProfileIds} : {}),
          ...(value.maxStageToolCalls !== undefined ? { maxStageToolCalls: value.maxStageToolCalls } : {}),
          ...(value.maxAgentCalls !== undefined ? { maxAgentCalls: value.maxAgentCalls } : {}),
          ...(value.maxInputTokens !== undefined ? { maxInputTokens: value.maxInputTokens } : {}),
          ...(value.maxRunMinutes !== undefined ? { maxRunMinutes: value.maxRunMinutes } : {}),
          ...(value.timeoutMinutes !== undefined ? { timeoutMinutes: value.timeoutMinutes } : {}),
          ...(value.maxRevisions !== undefined ? { maxRevisions: value.maxRevisions } : {}),
        });
        const teamPayload: Partial<AutomationSettings> = {
          agents: checked.agents,
          routingProfileIds: checked.routingProfileIds,
          pipeline: checked.pipeline,
          pipelineRoutes: checked.pipelineRoutes ?? [],
          ...(value.maxStageToolCalls !== undefined ? { maxStageToolCalls: checked.maxStageToolCalls } : {}),
          ...(value.maxAgentCalls !== undefined ? { maxAgentCalls: checked.maxAgentCalls } : {}),
          ...(value.maxInputTokens !== undefined ? { maxInputTokens: checked.maxInputTokens } : {}),
          ...(value.maxRunMinutes !== undefined ? { maxRunMinutes: checked.maxRunMinutes } : {}),
          ...(value.timeoutMinutes !== undefined ? { timeoutMinutes: checked.timeoutMinutes } : {}),
          ...(value.maxRevisions !== undefined ? { maxRevisions: checked.maxRevisions } : {}),
        };
        this.repos.meta.set(key, JSON.stringify(teamPayload));
      }
    }
    const override = JSON.parse(this.repos.meta.get(key) ?? 'null') as Partial<AutomationSettings> | null;
    return { overridden: !!override, settings: new AutomationSettingsValidator().validate({
      ...this.settings(), ...override, ...(override ? { pipelineRoutes: override.pipelineRoutes ?? [] } : {}),
    }) };
  }
  public list(taskId?: string): AgentRun[] {
    return this.runs.db.transaction(() => { this.expireLeases(); return this.runs.list(taskId).map((run) => this.publicRun(run)); });
  }
  public archive(): AgentRun[] { return this.runs.db.transaction(() => { this.expireLeases(); return this.runs.archived().map((run) => this.publicRun(run)); }); }
  public hide(id: string): void {
    this.runs.db.transaction(() => {
      this.expireLeases();
      const run = this.requireRun(id);
      if (ACTIVE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Active runs cannot be hidden; remove or stop the run first.');
      this.runs.archive(id, this.clock.now());
    });
  }
  public restore(id: string): void { this.runs.db.transaction(() => { this.requireRun(id); this.runs.restore(id); }); }
  public logPage(id: string, after = 0) { this.requireRun(id); return this.runs.eventPage(id, after); }
  public metrics(period: Partial<ImprovementPeriod> = {}) {
    return this.runs.db.transaction(() => {
      const asOf = this.clock.now();
      const end = period.to ?? asOf;
      const from = period.from ?? (Number.isFinite(Date.parse(end)) ? new Date(Date.parse(end) - 30 * 86400000).toISOString() : '');
      const date = (value: string) => {
        if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return NaN;
        const day = new Date(value.slice(0, 10));
        if (!Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
        return Date.parse(value);
      };
      const startAt = date(from), endAt = date(end);
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt)
        throw new TrackerError('VALIDATION_FAILED', 'Укажите корректные даты начала и конца периода. Начало должно быть раньше конца.');
      return collectMetrics(this.runs, { from: new Date(startAt).toISOString(), to: new Date(endAt).toISOString() }, asOf);
    });
  }

  public detail(id: string, eventId?: number) {
    return this.runs.db.transaction(() => { this.expireLeases(); const run = this.requireRun(id); return { run: this.runWithAvailableImages(run), item: this.queueItem(run, this.runs.list()), events: this.runs.events(id),
      selectedEvent: eventId === undefined ? undefined : this.runs.eventById(id, eventId),
      selectedOccurrence: eventId === undefined ? undefined : this.runs.occurrence(id, eventId),
      checks: this.runs.checks(id),
      userAcceptance: this.repos.tasks.findById(run.taskId)?.status === TaskStatus.Done ? this.runs.acceptedByUser(run.taskId) : undefined,
      previewPatch: { available: this.canPreviewPatch(run), active: this.projects.hasPreviewPatch(run.id), pending: this.projects.previewPatchPending(run.id) } }; });
  }

  public activeTaskIds(): string[] {
    return [...new Set([...this.runs.activeTaskIds(), ...this.runs.list().filter(r => ![RunStatus.Merged, RunStatus.Cancelled, RunStatus.Review].includes(r.status as 'merged' | 'cancelled' | 'review')).flatMap(r => r.feature?.children.map(c => c.taskId) ?? [])])];
  }
  public checkout(id: string, token: string, input: unknown): void {
    this.runs.db.transaction(() => {
      const run = this.owned(id, token); const value = input as NonNullable<AgentRun['checkout']>;
      const text = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 2048 && !/[\r\n\x00]/.test(s);
      if (!value || !text(value.repositoryRoot) || !text(value.worktreePath) || !/^[a-f0-9]{40,64}$/.test(value.baseSha)
        || !['isolated', 'linked'].includes(value.dependencyMode)) throw new TrackerError('VALIDATION_FAILED', 'Invalid checkout metadata.');
      if (run.checkout && (run.checkout.baseSha !== value.baseSha || run.checkout.repositoryRoot !== value.repositoryRoot || run.checkout.worktreePath !== value.worktreePath)) throw new TrackerError('CONFLICT', 'Checkout identity changed.');
      this.runs.save({ ...run, checkout: { repositoryRoot: value.repositoryRoot, worktreePath: value.worktreePath,
        baseSha: value.baseSha, dependencyMode: value.dependencyMode, dependencyKey: typeof value.dependencyKey === 'string' ? value.dependencyKey.slice(0, 128) : undefined,
        dependencyNote: typeof value.dependencyNote === 'string' ? value.dependencyNote.slice(0, 500) : undefined } });
    });
  }

  private runWithAvailableImages(run: AgentRun): AgentRun {
    const acceptance = run.acceptance;
    return { ...this.publicRun(run), acceptance: acceptance && { ...acceptance, results: acceptance.results.map(result => {
      const browser = result.source?.browser;
      if (!browser) return result;
      const url = new URL(browser.imageUrl, 'http://workspace.invalid');
      const file = /^\/api\/images\/([a-z\d]+\.png)$/.exec(url.pathname)?.[1];
      return file && url.searchParams.get('workspace') === this.workspace && this.images?.resolveFile(file)
        ? result : { ...result, source: undefined };
    }) } };
  }
  public integration(id: string, token: string, input: unknown): void {
    this.runs.db.transaction(() => {
      const run = this.owned(id, token); const value = input as IntegrationInfo;
      if (run.status !== RunStatus.Integrating || !value || !['preparing', 'resolving', 'checking', 'ready', 'publishing', 'merged', 'blocked'].includes(value.state)
        || value.sourceSha !== run.commitSha || !/^[a-f0-9]{40,64}$/.test(value.baseSha)
        || (value.candidateSha !== undefined && !/^[a-f0-9]{40,64}$/.test(value.candidateSha))
        || value.targetBranch !== run.settings.baseBranch || typeof value.worktreePath !== 'string' || value.worktreePath.length > 2048
        || !Number.isInteger(value.attempt) || value.attempt < 1 || (!run.trustedExecution && value.attempt > (run.settings.maxMergeAttempts ?? 2))) throw new TrackerError('VALIDATION_FAILED', 'Invalid integration metadata.');
      if ((value.state === 'ready' || value.state === 'publishing') && !value.candidateSha) throw new TrackerError('VALIDATION_FAILED', 'Verified candidate SHA is required.');
      const now = this.clock.now();
      const checkIds = value.checkIds;
      if (checkIds !== undefined && (!Array.isArray(checkIds) || !value.candidateSha
        || value.checkFingerprint !== checkFingerprint(run.settings.checks)
        || !verifyRefs(this.runs.checks(id), checkIds, run, 'candidate', value.candidateSha, run.stage, value.attempt)))
        throw new TrackerError('VALIDATION_FAILED', 'Candidate check evidence does not match the verified SHA and command set.');
      this.runs.save({ ...run, phase: RunPhase.Merge, phaseStartedAt: run.phase === RunPhase.Merge ? run.phaseStartedAt : now,
        budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
        integration: { state: value.state, sourceSha: value.sourceSha, baseSha: value.baseSha, candidateSha: value.candidateSha,
          targetBranch: value.targetBranch, worktreePath: value.worktreePath, attempt: value.attempt, noChanges: !!value.noChanges,
          checkIds, checkFingerprint: checkIds ? value.checkFingerprint : undefined,
          error: typeof value.error === 'string' ? value.error.slice(0, 3000) : undefined } });
      const eventId = this.runs.event(id, 'integration', `${value.state}: ${value.targetBranch} · ${value.candidateSha ?? value.baseSha}`, now);
      if (value.state === 'blocked') this.recordFailure(run, eventId, now, 'Интеграция остановлена.', false, value.candidateSha, value.attempt);
    });
  }

  public checkExecution(id: string, token: string, input: unknown, begin = false) {
    return this.runs.db.transaction(() => {
      const current = this.requireRun(id);
      const value = input as CheckExecution;
      if (!value || typeof value.id !== 'string' || !/^[a-f\d-]{36}$/.test(value.id)
        || !Number.isSafeInteger(value.position) || !Number.isSafeInteger(value.attempt) || value.attempt < 1
        || !/^[a-f\d]{40,64}$/.test(value.sha) || !checkBelongsToRun(value, current)
        || !value.outcome || !['exit', 'launch_error', 'unknown'].includes(value.outcome.kind)
        || (value.outcome.kind === 'exit' && !Number.isSafeInteger(value.outcome.code))
        || !Number.isFinite(Date.parse(value.at))) throw new TrackerError('VALIDATION_FAILED', 'Invalid check execution evidence.');
      if (value.browserResults !== undefined && (value.outcome.kind !== 'exit' || value.outcome.code !== 0
        || !Array.isArray(value.browserResults) || value.browserResults.length > SCREENSHOT_LIMIT
        || value.browserResults.some(result => !result || !/^[a-f\d]{64}$/.test(result.imageDigest) || !SCREENSHOT_PATH.test(result.screenshot)
          || [result.criterionId, result.action, result.assertion, result.actual].some(field => typeof field !== 'string' || !field.trim() || field.length > 500))))
        throw new TrackerError('VALIDATION_FAILED', 'Invalid browser assertion evidence.');
      const intent = this.runs.db.prepare('SELECT lease_hash, payload FROM automation_check_intents WHERE id = ? AND run_id = ?')
        .get<{ lease_hash: string; payload: string }>([value.id, id]);
      const leaseHash = createHash('sha256').update(token).digest('hex');
      const identity = (check: CheckExecution) => {
        const { outcome: _, browserResults: __, at: ___, ...context } = check;
        return JSON.stringify(context);
      };
      if (intent && identity(JSON.parse(intent.payload) as CheckExecution) !== identity(value))
        throw new TrackerError('CONFLICT', 'Check execution identity changed.');
      const cancelled = !begin && current.status === RunStatus.Cancelled && !!current.userCancelledAt && intent?.lease_hash === leaseHash;
      const run = cancelled ? current : this.owned(id, token);
      const existing = this.runs.check(id, value.id);
      if (existing && !begin) {
        const { eventId: _, ...prior } = existing;
        if (identity(prior) !== identity(value) || prior.at !== value.at || ((!cancelled || prior.outcome.kind !== 'cancelled')
          && JSON.stringify(prior.outcome) !== JSON.stringify(value.outcome))
          || JSON.stringify(prior.browserResults) !== JSON.stringify(value.browserResults))
          throw new TrackerError('CONFLICT', 'Check execution identity changed.');
        return existing;
      }
      if (value.phase === 'candidate' ? run.status !== RunStatus.Integrating || run.integration?.candidateSha !== value.sha
        || run.integration.attempt !== value.attempt : value.phase !== 'stage' || run.status !== RunStatus.Running
        || !PipelinePolicy.checkAt(run.settings, run.stage, run.feature)) {
        if (!cancelled) throw new TrackerError('CONFLICT', 'Execution belongs to a different stage or integration candidate.');
      }
      if (begin) {
        if (existing || value.outcome.kind !== 'unknown' || value.browserResults || (intent && intent.lease_hash !== leaseHash))
          throw new TrackerError('CONFLICT', 'Check execution was already started or finished.');
        this.runs.db.prepare('INSERT OR IGNORE INTO automation_check_intents(id, run_id, lease_hash, payload) VALUES (?, ?, ?, ?)')
          .run([value.id, id, leaseHash, JSON.stringify(value)]);
        return { ok: true };
      }
      if (!intent)
        throw new TrackerError('CONFLICT', 'Execution belongs to a different stage or integration candidate.');
      const result = this.runs.recordCheck(cancelled && value.outcome.kind === 'unknown' ? { ...value, outcome: { kind: 'cancelled' } } : value);
      if (!cancelled) this.runs.db.prepare('DELETE FROM automation_check_intents WHERE id = ?').run([value.id]);
      return result;
    });
  }
  public enqueue(taskId: string, draft?: unknown, persistSettings = true): AgentRun {
    return this.createRun(taskId, draft, undefined, persistSettings);
  }
  public enqueueBatch(taskIds: unknown, draft?: unknown, requestId?: unknown): AgentRun[] {
    if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > BATCH_TASK_LIMIT
      || taskIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(taskIds).size !== taskIds.length) {
      throw new TrackerError('VALIDATION_FAILED', `Выберите от 1 до ${BATCH_TASK_LIMIT} разных задач.`);
    }
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId))) throw new TrackerError('VALIDATION_FAILED', 'Некорректный идентификатор группового запроса.');
    const key = requestId ? 'automation_batch_' + requestId : undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify({ taskIds, draft })).digest('hex');
    return this.runs.db.transaction(() => {
      const receipt = key ? this.repos.meta.get(key) : undefined;
      if (receipt) {
        const saved = JSON.parse(receipt) as { fingerprint: string; ids: string[] };
        if (saved.fingerprint !== fingerprint) throw new TrackerError('CONFLICT', 'Этот идентификатор группы уже использован с другим составом или настройками.');
        return saved.ids.map(id => this.publicRun(this.requireRun(id)));
      }
      const runs = taskIds.map((id: string) => {
        try { return this.createRun(id, draft, undefined, false); }
        catch (error) {
          if (error instanceof TrackerError) throw new TrackerError(error.code, `${id}: ${error.message} Ни одна задача из группы не добавлена в очередь.`);
          throw error;
        }
      });
      if (key) this.repos.meta.set(key, JSON.stringify({ fingerprint, ids: runs.map(run => run.id) }));
      return runs;
    });
  }
  private createRun(taskId: string, draft?: unknown, previous?: AgentRun, persistSettings = true): AgentRun {
    return this.runs.db.transaction(() => {
      const task = this.tasks.getTaskCard(taskId);
      if (task.openQuestionsCount || task.status === TaskStatus.Done) throw new TrackerError('CONFLICT', 'Resolve task questions before starting automation.');
      const integrationRestart = previous && previous.stage >= previous.settings.pipeline.length && previous.settings.mergePolicy === MergePolicy.Local;
      if (!AUTOMATION_START_TASK_STATUSES.includes(task.status) && !(previous && (task.status === TaskStatus.InProgress || task.status === TaskStatus.Testing || (integrationRestart && task.status === TaskStatus.Review)))) throw new TrackerError('CONFLICT', 'Start a new run from backlog, planning or ready; resume an existing run for work already in progress.');
      const settings = new AutomationSettingsValidator().validate(draft === undefined ? this.taskTeam(taskId).settings : draft);
      if (integrationRestart && (settings.repositoryPath.replace(/\\/g, '/') !== previous.settings.repositoryPath.replace(/\\/g, '/')
        || settings.baseBranch !== previous.settings.baseBranch || settings.mergePolicy !== MergePolicy.Local)) throw new TrackerError('CONFLICT', 'Integration restart must keep the source repository, target branch and local merge policy.');
      const configurationProblems = PipelinePolicy.configurationProblems(settings);
      if (configurationProblems.length) throw new TrackerError('VALIDATION_FAILED', configurationProblems.join(' '));
      if (PipelinePolicy.needsPlan(settings, !!task.plan)) throw new TrackerError('VALIDATION_FAILED', 'Task needs an existing plan or an analyst before development.');
      if (this.activeTaskIds().includes(taskId)) throw new TrackerError('CONFLICT', 'Task already has an active run or belongs to an executing feature.');
      const now = this.clock.now();
      const pipelineConnections = settings.pipeline.map((agentId) => {
        const agent = settings.agents.find((a) => a.id === agentId);
        return agent ? settings.connections.find((c) => c.id === agent.connectionId) : undefined;
      });
      const hasLocal = pipelineConnections.some((c) => c?.isLocal || c?.kind === ProviderKind.Ollama);
      const trustedExecution = task.trustedExecution === true || hasLocal;
      const run: AgentRun = { id: randomUUID(), taskId, status: RunStatus.Queued, stage: 0, revision: 0,
        workerId: null, leaseToken: null, leaseUntil: null, settings, createdAt: now, updatedAt: now,
        trustedExecution, decompositionAllowed: PipelinePolicy.canDecompose(settings, true),
        ...(settings.skillBindings?.length ? { skillVersions: this.skillLibrary.versions(settings.skillBindings) } : {}),
        branch: null, commitSha: null, summary: '', restartedFromId: previous?.id, usageAttempts: [] };
      if (integrationRestart) {
        run.stage = settings.pipeline.length; run.integrationSourceSha = previous.commitSha!;
        run.commitSha = previous.commitSha; run.mergeMessage = previous.mergeMessage; run.acceptedSha = previous.acceptedSha;
      }
      this.runs.save(run);
      this.runs.event(run.id, RunStatus.Queued, 'Run queued with an immutable settings snapshot.', now);
      if (draft !== undefined && persistSettings) this.projectTeam.save(settings);
      return this.publicRun(run);
    });
  }
  public restart(id: string): AgentRun {
    return this.runs.db.transaction(() => {
      this.expireLeases();
      const previous = this.requireRun(id);
      if (!RESUMABLE_RUN_STATUSES.includes(previous.status)) throw new TrackerError('CONFLICT', 'Остановите текущий запуск перед повторным запуском.');
      if (this.tasks.getTaskCard(previous.taskId).openQuestionsCount) throw new TrackerError('CONFLICT', 'Сначала ответьте на вопросы в карточке задачи.');
      if (previous.status === RunStatus.Waiting) {
        const now = this.clock.now();
        this.runs.save({ ...previous, status: RunStatus.Cancelled, leaseToken: null, updatedAt: now, finishedAt: now });
      }
      const next = this.createRun(previous.taskId, this.taskTeam(previous.taskId).settings, previous, false);
      this.runs.event(previous.id, 'restarted', `Новый запуск с начала: ${next.id}. Используются сохранённые настройки команды.`, this.clock.now());
      return next;
    });
  }
  public queue(includeHistory?: boolean, taskId?: string): QueueSnapshot {
    return this.runs.db.transaction(() => {
      this.expireLeases();
      const runs = includeHistory === true ? this.runs.history(taskId) : includeHistory === false ? this.runs.queue().filter(run => [RunStatus.Queued, RunStatus.Running, RunStatus.Integrating].includes(run.status as 'queued' | 'running' | 'integrating')) : this.runs.queue();
      const queued = runs.filter((run) => run.status === RunStatus.Queued).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      const items = runs.map(entry => this.queueItem(entry, runs, queued));
      return { items, host: this.projects.status(), serverTime: this.clock.now() };
    });
  }
  private queueItem(entry: AgentRun, runs: AgentRun[], queued = runs.filter(run => run.status === RunStatus.Queued).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))): QueueItem {
    const run = this.refreshCleanup(entry);
    const task = this.tasks.getTaskCard(run.taskId);
    const otherActive = runs.some((other) => other.taskId === run.taskId && other.id !== run.id && ACTIVE_RUN_STATUSES.includes(other.status));
    const scope = Decomposition.child(run);
    const pendingQuestions = scope ? this.tasks.getTaskCard(scope.taskId).openQuestionsCount : task.openQuestionsCount;
    const actionReason = run.cleanup ? 'Рабочая копия очищается или уже очищена; продолжение этого запуска недоступно.'
      : this.projects.hasPreviewPatch(run.id) ? 'Перед продолжением откатите патч проверки.'
      : pendingQuestions ? `Ответьте на вопросы в карточке ${scope?.taskId ?? task.id}.` : otherActive ? 'У задачи есть другой активный запуск.'
      : task.status === TaskStatus.Done || (task.status === TaskStatus.Review && !(run.stage >= run.settings.pipeline.length && run.settings.mergePolicy === MergePolicy.Local)) ? 'Задача уже на проверке или завершена.' : '';
    const resumable = RESUMABLE_RUN_STATUSES.includes(run.status) && (run.stage < run.settings.pipeline.length || run.settings.mergePolicy === MergePolicy.Local);
    return { id: run.id, manualAcceptance: run.manualAcceptance, proposedFix: run.proposedFix, trustedExecution: run.trustedExecution === true, taskId: run.taskId, title: task.title, cleanup: run.cleanup, taskStatus: task.status, status: run.status, stage: run.stage, revision: run.revision,
      pipeline: run.settings.pipeline.map((id) => { const agent = run.settings.agents.find((a) => a.id === id)!; return { role: agent.role, runner: agent.runner, model: agent.model }; }),
      phase: run.phase, phaseStartedAt: run.phaseStartedAt, heartbeatAt: run.heartbeatAt ?? (run.leaseUntil ? new Date(Date.parse(run.leaseUntil) - LEASE_MS).toISOString() : undefined),
      progressAt: run.progressAt, lastMessage: run.lastMessage ?? '', createdAt: run.createdAt, startedAt: run.startedAt,
      attemptStartedAt: run.attemptStartedAt, finishedAt: run.finishedAt, updatedAt: run.updatedAt, summary: run.summary,
      workerId: run.workerId, branch: run.branch, checkout: run.checkout, integration: run.integration, integrationSourceSha: run.integrationSourceSha, restartedFromId: run.restartedFromId, openQuestions: task.openQuestionsCount,
      timeoutMinutes: run.settings.timeoutMinutes, tokenUsage: TokenMeter.summary(run.usageAttempts, run.usageIncomplete),
      queuePosition: run.status === RunStatus.Queued ? queued.findIndex((r) => r.id === run.id) + 1 : undefined,
      canResume: resumable && !actionReason, canRestart: RESUMABLE_RUN_STATUSES.includes(run.status) && !actionReason, actionReason };
  }
  public claim(workerId: string): AgentRun | null {
    if (!workerId.trim()) throw new TrackerError('VALIDATION_FAILED', 'Worker ID is required.');
    return this.runs.db.transaction(() => {
      const now = this.clock.now();
      this.expireLeases();
      const run = this.runs.nextQueued();
      if (!run) return null;
      let mergeReviewRequired = run.mergeReviewRequired;
      if (run.stage >= run.settings.pipeline.length && run.settings.mergePolicy === MergePolicy.Local) {
        const task = this.tasks.getTaskCard(run.taskId);
        if (!task.openQuestionsCount && task.status === TaskStatus.Ready) {
          this.tasks.setStatus({ id: run.taskId, status: TaskStatus.InProgress, actor: 'agent' });
          this.tasks.setStatus({ id: run.taskId, status: TaskStatus.Testing, actor: 'agent' }); mergeReviewRequired = true;
        }
      }
      const claimed: AgentRun = { ...run, mergeReviewRequired, status: run.stage >= run.settings.pipeline.length && run.settings.mergePolicy === MergePolicy.Local ? RunStatus.Integrating : RunStatus.Running, workerId, leaseToken: randomUUID(),
        leaseUntil: new Date(new Date(now).getTime() + LEASE_MS).toISOString(), startedAt: run.startedAt ?? now, updatedAt: now, heartbeatAt: now, phase: RunPhase.Preparing,
        phaseStartedAt: now, attemptStartedAt: now, budgetUpdatedAt: now, progressAt: undefined, lastMessage: '' };
      this.runs.save(claimed);
      return claimed;
    });
  }
  public heartbeat(id: string, token: string, recovery = false, publication = false): AgentRun {
    return this.runs.db.transaction(() => {
    const run = this.owned(id, token);
    const now = this.clock.now();
    const reason = RunBudget.reason(run, Date.parse(now));
    if (reason && !(run.status === RunStatus.Integrating && ((recovery && run.stage >= run.settings.pipeline.length)
      || (publication && run.integration?.state === 'publishing')))) throw new TrackerError('CONFLICT', reason);
    const updated = { ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
      updatedAt: now, heartbeatAt: now, leaseUntil: new Date(new Date(now).getTime() + LEASE_MS).toISOString() };
    this.runs.save(updated);
    return updated;
    });
  }
  public progress(id: string, token: string, text: string, phase?: RunPhase): void {
    return this.runs.db.transaction(() => {
    const merging = this.requireRun(id);
    const run = phase === RunPhase.Merge && merging.status === RunStatus.Review && merging.leaseToken === token && !!token
      && !!merging.leaseUntil && merging.leaseUntil >= this.clock.now() ? merging : this.owned(id, token);
    const now = this.clock.now();
    if (phase && !RUN_PHASES.includes(phase)) throw new TrackerError('VALIDATION_FAILED', 'Unknown execution phase.');
    const message = RunProgressText.format(text);
    this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
      updatedAt: now, progressAt: now, lastMessage: message || run.lastMessage,
      phase: phase ?? run.phase, phaseStartedAt: phase && phase !== run.phase ? now : run.phaseStartedAt });
    this.runs.event(id, phase ? 'phase' : 'progress', text, now);
    });
  }
  public beginStage(id: string, token: string, resolver = false): string {
    return this.runs.db.transaction(() => {
    const run = this.owned(id, token);
    const reason = RunBudget.reason(run, Date.parse(this.clock.now()), true);
    if (reason) throw new TrackerError('CONFLICT', reason);
    if (resolver !== (run.status === RunStatus.Integrating)) throw new TrackerError('CONFLICT', 'Execution phase does not match the requested agent.');
    if (!run.trustedExecution && resolver && (run.usageAttempts ?? []).filter(a => a.kind === 'resolver').length >= (run.settings.maxResolverCalls ?? 1)) throw new TrackerError('CONFLICT', 'Conflict resolver call budget exhausted.');
    const agent = resolver ? run.settings.agents.find(entry => entry.role === AgentRole.Developer) : TaskRouting.profile(run.settings, run.stage, run.routing);
    if (!agent) throw new TrackerError('CONFLICT', 'Pipeline has no current stage.');
    if (run.feature) {
      const parent = this.tasks.getTaskCard(run.taskId);
      if (parent.openQuestionsCount || parent.status === TaskStatus.Done) throw new TrackerError('CONFLICT', 'Resolve the parent feature state/questions before dispatching children.');
    }
    const task = this.tasks.getTaskCard(Decomposition.child(run)?.taskId ?? run.taskId);
    if (task.openQuestionsCount) throw new TrackerError('CONFLICT', 'Task has unanswered questions.');
    if (agent.role === AgentRole.Analyst) this.tasks.setStatus({ id: task.id, status: TaskStatus.Planning, actor: 'agent' });
    if (WRITABLE_AGENT_ROLES.includes(agent.role) && !resolver) this.tasks.setStatus({ id: task.id, status: agent.role === AgentRole.Developer && !task.plan ? TaskStatus.Planning : TaskStatus.InProgress, actor: 'agent' });
    if (agent.role === AgentRole.Tester && task.status === TaskStatus.InProgress) this.tasks.setStatus({ id: task.id, status: TaskStatus.Testing, actor: 'agent' });
    const now = this.clock.now();
    const attempt: UsageAttempt = { id: randomUUID(), kind: resolver ? 'resolver' : 'pipeline', stage: run.stage, revision: run.revision, role: agent.role, runner: agent.runner, model: agent.model,
      startedAt: now, updatedAt: now, finished: false };
    const legacyUsageMissing = run.usageAttempts === undefined && (run.stage > 0 || run.revision > 0 || this.runs.events(id).some((event) => event.kind === 'stage'));
    this.runs.save({ ...run, ...(agent.role === AgentRole.Router ? {routingInputDescription: task.description ?? ''} : {}), phase: RunPhase.Agent, phaseStartedAt: now, updatedAt: now, lastMessage: '',
      budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
      usageIncomplete: run.usageIncomplete || legacyUsageMissing, usageAttempts: [...(run.usageAttempts ?? []), attempt] });
    this.runs.event(id, 'stage', `${agent.role}: ${agent.runner} / ${agent.model}`, this.clock.now());
    return attempt.id;
    });
  }
  public checkpoint(id: string, token: string, attemptId: string, value: unknown): StageMemory {
    return this.runs.db.transaction(() => {
      const run = this.owned(id, token);
      const attempt = run.usageAttempts?.at(-1);
      if (!attempt || attempt.id !== attemptId || attempt.finished || attempt.kind !== 'pipeline' || attempt.stage !== run.stage || attempt.revision !== run.revision)
        throw new TrackerError('CONFLICT', 'Checkpoint belongs to an inactive agent attempt.');
      const input = value as { key?: unknown; note?: unknown; conversationId?: unknown };
      if (!input || typeof input.key !== 'string' || !/^[a-f0-9]{64}$/.test(input.key) || Object.keys(input).some(key => !['key', 'note', 'conversationId'].includes(key)))
        throw new TrackerError('VALIDATION_FAILED', 'Invalid checkpoint envelope.');
      const taskId = Decomposition.child(run)?.taskId ?? run.taskId;
      const previous = run.stageMemory?.key === input.key && run.stageMemory.stage === run.stage && run.stageMemory.revision === run.revision && run.stageMemory.taskId === taskId ? run.stageMemory : undefined;
      let note; let conversationId;
      try { note = input.note === undefined ? previous?.note : StageNotes.parse(input.note); conversationId = input.conversationId === undefined ? previous?.conversationId : StageNotes.session(input.conversationId); }
      catch (error) { throw new TrackerError('VALIDATION_FAILED', error instanceof Error ? error.message : 'Invalid checkpoint.'); }
      if (previous?.conversationId && conversationId !== previous.conversationId) throw new TrackerError('CONFLICT', 'Native conversation changed within the same stage context.');
      const changed = note && JSON.stringify(note) !== JSON.stringify(previous?.note);
      const now = this.clock.now();
      const memory: StageMemory = { key: input.key, taskId, stage: run.stage, revision: run.revision, updatedAt: now, note, conversationId };
      let workPlan = run.workPlan;
      const plan = note ? StageNotes.plan(note) : undefined;
      if (attempt.role === AgentRole.Developer && plan && !this.tasks.getTaskCard(taskId).plan) {
        this.tasks.attachPlan({ id: taskId, planContent: plan, summary: note!.summary, statusMode: 'none', actor: 'agent' });
        const saved = this.tasks.getTaskCard(taskId).plan!;
        workPlan = { taskId, version: saved.version, contentHash: createHash('sha256').update(JSON.stringify(saved.content)).digest('hex'), stage: run.stage, revision: run.revision };
        this.tasks.setStatus({ id: taskId, status: TaskStatus.InProgress, actor: 'agent' });
      }
      this.runs.save({ ...run, stageMemory: memory, workPlan, updatedAt: now,
        usageAttempts: run.usageAttempts?.map(value => value.id === attemptId ? { ...value, nativeSessionId: conversationId } : value) });
      if (changed && note) {
        this.tasks.addComment({ id: taskId, text: `[CHECKPOINT ${attempt.role} · ${id.slice(0, 8)} · этап ${run.stage + 1}]\n${StageNotes.format(note)}`, kind: 'note', actor: 'agent' });
        this.runs.event(id, 'checkpoint', `Промежуточный результат ${attempt.role} сохранён в карточке ${taskId}.`, now);
      }
      return memory;
    });
  }
  public usage(id: string, token: string, attemptId: string, usage: unknown, finished: boolean): void {
    this.runs.db.transaction(() => {
      const run = this.owned(id, token);
      const attempts = run.usageAttempts ?? [];
      const attempt = attempts.find((a) => a.id === attemptId);
      if (!attempt) throw new TrackerError('CONFLICT', 'Unknown usage attempt.');
      if (usage !== undefined && !TokenMeter.valid(usage)) throw new TrackerError('VALIDATION_FAILED', 'Invalid token usage.');
      if (attempt.finished) return;
      if (attempt.stage !== run.stage || attempt.revision !== run.revision) throw new TrackerError('CONFLICT', 'Usage attempt is not the current stage.');
      const sample = usage as TokenUsage | undefined;
      if (attempt.usage && sample) {
        if (sample.source !== attempt.usage.source) throw new TrackerError('VALIDATION_FAILED', 'Usage source changed.');
        // Ignore delayed heartbeat snapshots; snapshots are cumulative, never additive.
        // Antigravity terminal usage is an authoritative aggregate (one record),
        // replacing several per-step records rather than another monotonic sample.
        const terminalAggregate = finished && sample.source === 'antigravity-json';
        if (!terminalAggregate && (sample.inputTokens < attempt.usage.inputTokens || sample.outputTokens < attempt.usage.outputTokens
          || sample.reportedRequests < attempt.usage.reportedRequests || sample.missingRequests < attempt.usage.missingRequests)) return;
      }
      const now = this.clock.now();
      this.runs.save({ ...run, usageAttempts: attempts.map((a) => a.id !== attemptId ? a : { ...a, updatedAt: now,
        finished: a.finished || finished, usage: sample ?? a.usage }) });
    });
  }
  public completeStage(id: string, token: string, outcome: AgentOutcome, branch: string, commitSha: string,
    screenshots?: unknown, checkFailed = false, checkIds?: string[], criterionImages?: unknown): AgentRun {
    return this.runs.db.transaction(() => {
      const run = this.owned(id, token);
      if (run.status !== RunStatus.Running) throw new TrackerError('CONFLICT', 'Pipeline is already complete.');
      if (!outcome || !AGENT_VERDICTS.includes(outcome.verdict) || typeof outcome.summary !== 'string') throw new TrackerError('VALIDATION_FAILED', 'Invalid agent verdict.');
      if (!/^[a-f0-9]{40,64}$/.test(commitSha) || !/^sat\/[\w-]+$/.test(branch)) throw new TrackerError('VALIDATION_FAILED', 'Worker must provide branch and commit SHA.');
      const profile = run.settings.agents.find((agent) => agent.id === run.settings.pipeline[run.stage])!;
      const child = Decomposition.child(run);
      const taskId = child?.taskId ?? run.taskId;
      const roles = PipelinePolicy.roles(run.settings);
      const submitsProposal = profile.role === AgentRole.Analyst && roles[run.stage + 1] === AgentRole.PlanReviewer;
      const reviewingPlan = profile.role === AgentRole.PlanReviewer;
      const proposal = reviewingPlan ? run.planProposal : undefined;
      if (reviewingPlan && !proposal) throw new TrackerError('CONFLICT', 'No analyst proposal is available for plan review.');
      if (outcome.questions?.some(q => typeof q === 'string' && q.trim())) outcome = { ...outcome, verdict: AgentVerdict.Questions };
      if (proposal && outcome.verdict === AgentVerdict.Pass && proposal.taskKey !== this.planReviewKey(this.tasks.getTaskCard(taskId))) {
        outcome = { ...outcome, verdict: AgentVerdict.ChangesRequested, summary: 'Требования или план в карточке изменились после анализа. Подготовь новую версию по актуальной карточке.' };
      }
      if (run.routing && profile.role !== AgentRole.Router && run.routing.sourceDescription !== (this.tasks.getTaskCard(taskId).description ?? '')) throw new TrackerError('VALIDATION_FAILED', 'Requirements changed after routing; resume the run to refresh routing in the saved worktree.');
      const now = this.clock.now();
      let updated: AgentRun = { ...run, branch, commitSha, updatedAt: now, summary: outcome.summary,
        budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now };
      updated.budgetApproval = undefined;
      if (checkIds !== undefined) {
        if (!Array.isArray(checkIds) || !PipelinePolicy.checkAt(run.settings, run.stage, run.feature)
          || !verifyRefs(this.runs.checks(id), checkIds, run, 'stage', commitSha, run.stage))
          throw new TrackerError('VALIDATION_FAILED', 'Stage check evidence does not match the verified SHA and command set.');
        const prior = run.stageChecks ?? [];
        updated.stageChecks = [...prior.filter(value => value.stage !== run.stage),
          { stage: run.stage, revision: run.revision, sha: commitSha, ids: checkIds }];
      }
      if (profile.role === AgentRole.Router && outcome.verdict === AgentVerdict.Pass) {
        if (run.routingInputDescription !== undefined && run.routingInputDescription !== (this.tasks.getTaskCard(taskId).description ?? '')) throw new TrackerError('VALIDATION_FAILED', 'Requirements changed after routing; resume the router with the latest task.');
        let decision;
        try { decision = TaskRouting.parse(outcome.plan ?? '', run.settings, run.stage); }
        catch (error) { throw new TrackerError('VALIDATION_FAILED', String(error)); }
        if (decision.uncertainty === 'high' && !PipelinePolicy.roles(run.settings).includes(AgentRole.Analyst)) throw new TrackerError('VALIDATION_FAILED', 'High uncertainty requires an analyst or user answers.');
        decision.assignments = decision.assignments.filter(a => !run.profileOverrides?.includes(a.stage));
        updated.routing = { decision, sourceDescription: this.tasks.getTaskCard(taskId).description ?? '', createdAt: now };
        this.runs.event(id, 'routing', JSON.stringify({complexity: decision.complexity, risk: decision.risk, uncertainty: decision.uncertainty, replacements: decision.assignments.length, criteria: decision.brief.criteria.length}), now);
      }
      let writerAcceptanceFailed = false;
      if (run.routing && WRITABLE_AGENT_ROLES.includes(profile.role)) updated.acceptance = undefined;
      if (run.routing && PipelinePolicy.reportsAcceptance(run.settings, run.stage) && outcome.verdict === AgentVerdict.Pass) {
        try {
          const brief = run.routing.decision.brief;
          const images = Array.isArray(criterionImages) && criterionImages.length ? this.attachStageScreenshots(taskId, criterionImages, now) : new Map<string, string>();
          const checks = this.runs.checks(id).filter(check => checkIds?.includes(check.id));
          const results = TaskRouting.acceptance(outcome.plan ?? '', brief).map(result => {
            const method = brief.criteria.find(item => item.id === result.id)!.method;
            if (method === 'manual' || result.status !== 'passed') return result;
            for (const check of checks) {
              const base = { checkId: check.id, eventId: check.eventId, attempt: check.attempt, sha: check.sha };
              if (method !== 'browser' && check.position === result.checkPosition) return { ...result, source: base };
              if (method === 'browser') {
                for (const scenario of check.browserResults ?? []) {
                  const imageUrl = images.get(scenario.imageDigest);
                  if (scenario.criterionId === result.id && imageUrl) {
                    const { action, assertion, actual } = scenario;
                    const source: AcceptanceResult['source'] = { ...base, browser: { action, assertion, actual, imageUrl } };
                    return { ...result, source };
                  }
                }
              }
            }
            if (WRITABLE_AGENT_ROLES.includes(profile.role)) return { ...result, status: 'failed' as const, evidence: 'No matching worker check evidence.' };
            return result;
          });
          updated.acceptance = { sha: commitSha, results };
          const failures = results.filter(result => result.status === 'failed');
          if (failures.length) {
            writerAcceptanceFailed = WRITABLE_AGENT_ROLES.includes(profile.role);
            outcome = { ...outcome, verdict: AgentVerdict.ChangesRequested, summary: 'Acceptance criteria failed. ' + failures.map(result => result.id + ': ' + result.evidence).join('\n') };
            updated.summary = outcome.summary;
          }
          if (results.some(r => r.status === 'manual')) this.tasks.addComment({ id: taskId, text: 'Требуется ручная проверка: ' + results.filter(r => r.status === 'manual').map(r => r.id).join(', '), kind: 'note', actor: 'agent' });
          this.runs.event(id, 'acceptance', JSON.stringify({sha: commitSha, total: results.length, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, manual: results.filter(r => r.status === 'manual').length}), now);
        } catch (error) { throw new TrackerError('VALIDATION_FAILED', String(error)); }
      }
      if (WRITABLE_AGENT_ROLES.includes(profile.role) && typeof outcome.commitMessage === 'string') {
        if (child) {
          if (outcome.verdict === AgentVerdict.Pass) updated.feature = { ...run.feature!, children: run.feature!.children.map(c => c.key === child.key ? { ...c, commitMessage: outcome.commitMessage, sourceSha: commitSha, state: 'review' } : c) };
        }
        else updated.mergeMessage = outcome.commitMessage;
      }
      if (EVIDENCE_AGENT_ROLES.includes(profile.role) || PipelinePolicy.checkAt(run.settings, run.stage, run.feature)) {
        this.tasks.addAttachment(taskId, { kind: 'report', name: `${profile.role}-${run.id}-${run.revision}.md`,
          content: `# ${profile.role}\n\nVerdict: ${outcome.verdict}\nCommit: ${commitSha}\nBranch: ${branch}\n\n${outcome.summary}\n\n## Worker evidence\n${this.runs.events(id).filter((event) => event.kind === 'progress').slice(-10).map((event) => event.text).join('\n')}` });
      }
      const budgetReason = RunBudget.reason(run, Date.parse(now));
      const retryWriterCheck = (checkFailed || writerAcceptanceFailed) && WRITABLE_AGENT_ROLES.includes(profile.role) && PipelinePolicy.checkAt(run.settings, run.stage, run.feature);
      const doctorRepair = run.doctorRepair?.revision === run.revision ? run.doctorRepair : undefined;
      if (doctorRepair && (outcome.verdict !== AgentVerdict.Pass || run.stage >= doctorRepair.failedStage)) updated.doctorRepair = undefined;
      if ((budgetReason && outcome.verdict !== AgentVerdict.Questions) || outcome.verdict === AgentVerdict.Blocked
        || (doctorRepair && outcome.verdict === AgentVerdict.ChangesRequested)
        || (run.retryCurrentStage === run.stage && outcome.verdict === AgentVerdict.ChangesRequested)
        || (outcome.verdict === AgentVerdict.ChangesRequested && WRITABLE_AGENT_ROLES.includes(profile.role) && !retryWriterCheck)) {
        updated = { ...updated, status: RunStatus.Failed, leaseToken: null,
          summary: budgetReason ?? `Execution blocked; no automatic retry: ${outcome.summary}` };
      } else if (outcome.verdict === AgentVerdict.Questions) {
        if (!Array.isArray(outcome.questions) || !outcome.questions.length || !outcome.questions.every((question) => typeof question === 'string' && question.trim())) throw new TrackerError('VALIDATION_FAILED', 'Questions verdict requires questions.');
        if (profile.role === AgentRole.Analyst && !submitsProposal && outcome.plan?.trim()) this.tasks.attachPlan({ id: taskId, planContent: outcome.plan, summary: outcome.summary, statusMode: 'none', actor: 'agent' });
        this.tasks.askQuestions({ id: taskId, questions: outcome.questions, actor: 'agent' });
        updated = { ...updated, status: RunStatus.Waiting, leaseToken: null };
        if (proposal) {
          updated.stage = run.stage - 1;
          updated.planProposal = { ...proposal, feedback: outcome.summary };
        }
      } else if (outcome.verdict === AgentVerdict.ChangesRequested) {
        if (profile.role === AgentRole.Analyst) throw new TrackerError('VALIDATION_FAILED', 'Analyst must return a plan or questions.');
        const route = PipelinePolicy.route(run.settings, run.stage)?.retry;
        const developer = PipelinePolicy.revisionStage(run.settings, run.stage, retryWriterCheck, run.feature);
        if (proposal) {
          const used = run.routeRetries?.[run.stage] ?? 0;
          updated.stage = run.stage - 1;
          updated.routeRetries = { ...run.routeRetries, [run.stage]: used + 1 };
          updated.planProposal = { ...proposal, feedback: outcome.summary };
          if (!run.trustedExecution && used >= run.settings.maxRevisions) {
            updated.status = RunStatus.Failed;
            updated.leaseToken = null;
            updated.summary = `Лимит возвратов плана исчерпан. ${outcome.summary}`;
            updated.lastRoute = { from: run.stage, to: updated.stage, kind: 'exhausted' };
          } else {
            updated.lastRoute = { from: run.stage, to: updated.stage, kind: 'retry' };
          }
        } else if (route) {
          const used = run.routeRetries?.[run.stage] ?? 0;
          const target = run.settings.pipeline.indexOf(route.to);
          if (used < route.limit) {
            updated = { ...updated, stage: target, revision: run.revision + 1,
              routeRetries: { ...run.routeRetries, [run.stage]: used + 1 },
              lastRoute: { from: run.stage, to: target, kind: 'retry' } };
          } else {
            const summary = `Лимит возвратов этапа ${run.stage + 1} исчерпан (${used}/${route.limit}). ${outcome.summary}`;
            if (route.exhausted === 'ask') {
              this.tasks.askQuestions({ id: taskId, questions: [
                `${summary.slice(0, 1200)} Как продолжить проверку?`,
              ], actor: 'agent' });
            }
            updated = { ...updated, status: route.exhausted === 'ask' ? RunStatus.Waiting : RunStatus.Failed,
              leaseToken: null, summary, lastRoute: { from: run.stage, to: run.stage, kind: 'exhausted' } };
          }
        } else {
          updated = developer < 0 ? { ...updated, status: RunStatus.Review, leaseToken: null } : (checkFailed || !run.trustedExecution) && run.revision >= run.settings.maxRevisions
            ? { ...updated, status: RunStatus.Failed, leaseToken: null, summary: `Revision limit reached: ${outcome.summary}` }
            : { ...updated, stage: developer, revision: run.revision + 1 };
        }
      } else {
        if (profile.role === AgentRole.Analyst || proposal) {
          const analysis = proposal ?? outcome;
          if (!analysis.plan?.trim()) throw new TrackerError('VALIDATION_FAILED', 'Analyst must return a plan.');
          const parts = (run.decompositionAllowed ?? PipelinePolicy.canDecompose(run.settings)) ? analysis.decomposition : undefined;
          if (submitsProposal) {
            updated.planProposal = { plan: analysis.plan.trim(), decomposition: parts?.length ? Decomposition.validate(parts) : undefined,
              taskKey: this.planReviewKey(this.tasks.getTaskCard(taskId)) };
          } else {
            this.tasks.attachPlan({ id: run.taskId, planContent: analysis.plan, summary: outcome.summary, actor: 'agent' });
            updated.planProposal = undefined;
          }
          if (!submitsProposal && parts?.length) {
            if (run.feature) throw new TrackerError('CONFLICT', 'Feature was already decomposed.');
            let planned;
            try { planned = FeaturePlanning.apply({ ...run, settings: { ...run.settings, agents: run.settings.agents.filter(agent => run.settings.pipeline.includes(agent.id)) } }, { ...outcome, decomposition: parts }, this.tasks); }
            catch (error) { throw new TrackerError('VALIDATION_FAILED', String(error)); }
            updated = { ...updated, feature: planned.feature, settings: { ...run.settings, pipeline: planned.pipeline, maxAgentCalls: planned.feature.callBudget!.limit } };
            this.runs.event(id, 'budget', `Автоматический расчёт: план ${planned.feature.callBudget!.planned}, исправления ${planned.feature.callBudget!.revisions}, resolver ${planned.feature.callBudget!.resolver}, предел ${planned.feature.callBudget!.limit}. Лимиты токенов и времени сохранены.`, now);
            this.tasks.setStatus({ id: run.taskId, status: TaskStatus.InProgress, actor: 'agent' });
            const title = this.tasks.getTaskCard(run.taskId).title.replace(/\s+/g, ' ').slice(0, 120);
            updated.mergeMessage = `[#${run.taskId}] - Объединены изменения «${title}» для реализации общей фичи`;
          }
        }
        if (child && profile.role === AgentRole.Reviewer) {
          const delivery = outcome.delivery;
          if (!delivery || delivery.childKey !== child.key || delivery.sourceSha !== run.commitSha || delivery.mergedSha !== commitSha) throw new TrackerError('VALIDATION_FAILED', 'Reviewed child requires a durable squash delivery.');
          updated.feature = { ...run.feature!, children: run.feature!.children.map(c => c.key === child.key ? { ...c, state: 'merged', sourceSha: delivery.sourceSha, mergedSha: commitSha } : c) };
          this.tasks.setStatus({ id: taskId, status: TaskStatus.Testing, actor: 'agent' });
          this.tasks.setStatus({ id: taskId, status: TaskStatus.Review, actor: 'agent' });
        }
        const next = PipelinePolicy.passStage(run.settings, run.stage);
        if (run.routing && PipelinePolicy.writes(run.settings) && next >= run.settings.pipeline.length
          && (!updated.acceptance || updated.acceptance.sha !== commitSha || updated.acceptance.results.some(r => r.status === 'failed'))) throw new TrackerError('VALIDATION_FAILED', 'Current commit has no passing acceptance report.');
        updated = { ...updated, stage: next };
        if (run.settings.pipelineRoutes?.length || proposal) updated.lastRoute = { from: run.stage, to: next, kind: 'pass' };
        if (child && updated.stage === updated.feature?.finalDeveloperStage) updated.stage++;
        if (updated.stage >= updated.settings.pipeline.length) {
          const writes = PipelinePolicy.writes(run.settings);
          if (writes) {
            const status = this.tasks.getTaskCard(run.taskId).status;
            if (status !== TaskStatus.InProgress && status !== TaskStatus.Testing) this.tasks.setStatus({ id: run.taskId, status: TaskStatus.InProgress, actor: 'agent' });
            if (this.tasks.getTaskCard(run.taskId).status === TaskStatus.InProgress) this.tasks.setStatus({ id: run.taskId, status: TaskStatus.Testing, actor: 'agent' });
            this.tasks.setStatus({ id: run.taskId, status: TaskStatus.Review, actor: 'agent' });
          }
          updated = { ...updated, status: RunStatus.Review, leaseToken: null };
        }
      }
      if (run.retryCurrentStage === run.stage) updated.retryCurrentStage = undefined;
      if (updated.status === RunStatus.Failed || updated.status === RunStatus.Review) updated = { ...updated, finishedAt: now };
      this.runs.save(updated);
      if (updated.lastRoute && updated.lastRoute !== run.lastRoute) {
        const { from, to, kind } = updated.lastRoute;
        const destination = to >= run.settings.pipeline.length ? 'ручная приёмка' : `этап ${to + 1}`;
        this.runs.event(id, 'route', kind === 'exhausted' ? updated.summary
          : `Этап ${from + 1} → ${destination}. ${kind === 'retry' ? `Возврат ${updated.routeRetries?.[from]}/${PipelinePolicy.route(run.settings, from)?.retry?.limit ?? run.settings.maxRevisions}. ${outcome.summary}` : 'Проверка пройдена.'}`, now);
      }
      const eventId = this.runs.event(id, updated.status === RunStatus.Failed ? 'failed' : outcome.verdict, updated.summary, now);
      if (outcome.verdict === AgentVerdict.ChangesRequested || updated.status === RunStatus.Failed) {
        const failedCheck = this.failedCheck(run, 'stage', commitSha);
        this.recordFailure(run, failedCheck?.eventId ?? eventId, now,
          failedCheck ? 'Обязательная проверка завершилась отказом.' : 'Этап потребовал исправления по итогам проверки.',
          outcome.verdict === AgentVerdict.ChangesRequested, commitSha, failedCheck?.attempt);
      }
      this.tasks.addComment({ id: taskId, text: `[AGENT ${profile.role}] ${outcome.summary}\nBranch: ${branch}\nCommit: ${commitSha}`, kind: 'note', actor: 'agent' });
      if (screenshots !== undefined) this.attachStageScreenshots(taskId, screenshots, now);
      return updated;
    });
  }
  private planReviewKey(task: TaskCard): string {
    return createHash('sha256').update(JSON.stringify({ title: task.title, description: task.description, plan: task.plan?.attachmentId, questions: task.questions })).digest('hex');
  }
  private attachStageScreenshots(taskId: string, screenshots: unknown, now: string): Map<string, string> {
    if (!this.images || !Array.isArray(screenshots) || screenshots.length > SCREENSHOT_LIMIT
      || screenshots.some(image => typeof image !== 'string' || image.length > SCREENSHOT_MAX_ENCODED_LENGTH
        || !/^data:image\/png;base64,iVBORw0KGg[A-Za-z0-9+/]*={0,2}$/.test(image))) {
      throw new TrackerError('VALIDATION_FAILED', 'Invalid stage screenshots.');
    }
    const urls = new Map<string, string>();
    for (const image of new Set<string>(screenshots)) {
      const stored = this.images.storeDataUrl(image, true);
      const url = `${stored.url}?workspace=${encodeURIComponent(this.workspace)}`;
      if (!this.repos.images.listByTask(taskId).some(existing => existing.url === url)) this.repos.images.add(taskId, url, now);
      urls.set(createHash('sha256').update(image).digest('hex'), url);
    }
    return urls;
  }
  public fail(id: string, token: string, message: string, recoveryError?: string, evidence?: unknown): void {
    return this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    if (!token || run.leaseToken !== token || !OWNED_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Run is no longer owned by this worker.');
    const now = this.clock.now();
    this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
      proposedFix: recoveryError ? {
        id: randomUUID(), title: 'Автоматическое восстановление этапа остановилось',
        explanation: 'Первый сбой: ' + recoveryError.slice(0, 2000) + '\n\nПричина остановки: ' + message.slice(0, 4000),
        diff: '', files: [], createdAt: now, action: 'retry_stage',
      } : run.proposedFix,
      status: run.status === RunStatus.Integrating ? RunStatus.MergeBlocked : RunStatus.Failed,
      integration: run.integration ? { ...run.integration, state: 'blocked', error: message } : undefined, finishedAt: now,
      leaseToken: null, updatedAt: now, summary: message });
    const eventId = this.runs.event(id, RunStatus.Failed, message, now);
    const phase = run.status === RunStatus.Integrating ? 'candidate' : 'stage';
    const sha = (phase === 'candidate' ? run.integration?.candidateSha : run.commitSha) ?? undefined;
    const check = this.failedCheck(run, phase, sha);
    const suppliedScripts = (evidence as { missingCheckScripts?: unknown } | undefined)?.missingCheckScripts;
    const configured = configuredCheckScripts(run.settings.checks);
    const missing = Array.isArray(suppliedScripts) && suppliedScripts.length && suppliedScripts.every(name =>
      typeof name === 'string' && /^[\w:.-]{1,128}$/.test(name) && configured.includes(name))
      ? [...new Set<string>(suppliedScripts)].sort() : undefined;
    const cause = missing && { key: createHash('sha256').update(JSON.stringify(['missing_check_scripts', run.settings.repositoryPath,
      run.settings.baseBranch, missing])).digest('hex'), description: `В package.json отсутствуют скрипты ${missing.join(', ')}.` };
    this.recordFailure(run, cause ? eventId : check?.eventId ?? eventId, now,
      cause ? 'Проверка наличия обязательных скриптов остановила запуск.' : check ? 'Обязательная проверка завершилась отказом.' : 'Выполнение остановлено с ошибкой.',
      !!check || !!cause, check?.sha ?? sha, check?.attempt ?? run.integration?.attempt, cause || undefined);
    this.tasks.addComment({ id: run.taskId, text: `[AUTOMATION FAILED] ${message}`, actor: 'agent' });
    });
  }
  private failedCheck(run: AgentRun, phase: CheckExecution['phase'], sha?: string) {
    return this.runs.checks(run.id).reverse().find(check => checkBelongsToRun(check, run) && check.phase === phase
      && (sha === undefined || phase === 'stage' || check.sha === sha)
      && (phase !== 'candidate' || check.attempt === run.integration?.attempt)
      && (check.outcome.kind === 'launch_error' || (check.outcome.kind === 'exit' && check.outcome.code !== 0)));
  }
  private recordFailure(run: AgentRun, eventId: number, at: string, fact: string, technicalRejection: boolean, sha?: string,
    attempt?: number, cause?: { key: string; description: string }): void {
    const profile = run.settings.agents.find(agent => agent.id === run.settings.pipeline[run.stage]);
    const attempts = run.usageAttempts ?? [];
    this.improvements.recordOccurrence({ runId: run.id, eventId, taskId: Decomposition.child(run)?.taskId ?? run.taskId, at, fact, sha,
      attempt: attempt ?? (attempts.length || undefined), revision: run.revision, phase: run.phase ?? run.status,
      role: profile?.role, executor: profile && `${profile.runner} / ${profile.model}`, technicalRejection, cause,
      recommendation: cause && 'Согласовать имена обязательных команд в настройках с текущим package.json.' });
  }
  public cancel(id: string): void {
    return this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Run is not active.');
    if (run.status === RunStatus.Integrating && run.integration?.state === 'publishing') throw new TrackerError('CONFLICT', 'Squash publication is already authorized; wait for its result before cancelling.');
    const now = this.clock.now();
    this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
      status: RunStatus.Cancelled, leaseToken: null, updatedAt: now, finishedAt: now, userCancelledAt: now });
    this.runs.event(id, RunStatus.Cancelled, 'Остановлено пользователем. Worker отменит текущую операцию после проверки lease.', now);
    });
  }
  public dequeue(id: string): void {
    return this.runs.db.transaction(() => {
      const run = this.requireRun(id);
      if (run.status !== RunStatus.Queued) throw new TrackerError('CONFLICT', 'Запуск уже покинул очередь. Обновите состояние; выполняющийся запуск можно остановить отдельно.');
      const now = this.clock.now();
    this.runs.save({ ...run, status: RunStatus.Cancelled, leaseToken: null, summary: 'Убрано из очереди. Задача и журнал сохранены.', updatedAt: now, finishedAt: now, userCancelledAt: now });
      this.runs.event(id, RunStatus.Cancelled, 'Убрано из очереди пользователем. Задача и журнал сохранены.', now);
    });
  }
  public changeStageProfile(id: string, stage: unknown, profileId: unknown, model?: unknown, expectedProfileId?: unknown): AgentRun {
    return this.runs.db.transaction(() => {
      const run = this.requireRun(id);
      if (!Number.isSafeInteger(stage) || typeof stage !== 'number' || stage < run.stage || stage >= run.settings.pipeline.length)
        throw new TrackerError('CONFLICT', 'Можно менять только текущий или будущий этап. Обновите сведения о запуске.');
      if (run.cleanup || run.feature || this.projects.hasPreviewPatch(run.id) || ![RunStatus.Queued, RunStatus.Running, ...RESUMABLE_RUN_STATUSES].includes(run.status))
        throw new TrackerError('CONFLICT', 'Для этого состояния смена профиля недоступна.');
      if (run.status === RunStatus.Running && stage === run.stage) throw new TrackerError('CONFLICT', 'Сначала остановите текущий этап. Будущие этапы можно менять во время работы.');
      const original = run.settings.agents.find(a => a.id === run.settings.pipeline[stage])!;
      if (expectedProfileId !== undefined && expectedProfileId !== original.id) throw new TrackerError('CONFLICT', 'Профиль этапа уже изменился. Обновите запуск.');
      const configured = this.settings();
      const replacement = configured.agents.find(a => a.id === profileId && a.role === original.role);
      const connection = configured.connections.find(c => c.id === replacement?.connectionId);
      if (!replacement || !connection) throw new TrackerError('VALIDATION_FAILED', 'Выберите профиль той же роли из настроек проекта.');
      const selectedModel = model ?? replacement.model;
      if (typeof selectedModel !== 'string' || !selectedModel.trim() || selectedModel.length > 300 || /[\x00-\x1f]/.test(selectedModel)) throw new TrackerError('VALIDATION_FAILED', 'Invalid replacement model.');
      const newId = randomUUID(), connectionId = randomUUID();
      const rename = (value: string) => value === original.id ? newId : value;
      const settings = new AutomationSettingsValidator().validate({ ...run.settings,
        agents: [...run.settings.agents, { ...replacement, id: newId, connectionId, model: selectedModel }],
        connections: [...run.settings.connections, { ...connection, id: connectionId }],
        pipeline: run.settings.pipeline.map((value, index) => index === stage ? newId : value),
        pipelineRoutes: run.settings.pipelineRoutes?.map(r => ({...r, from: rename(r.from), passTo: typeof r.passTo === 'string' ? rename(r.passTo) : r.passTo,
          ...(r.retry ? {retry: {...r.retry, to: rename(r.retry.to)}} : {})})),
      });
      const now = this.clock.now();
      const updated: AgentRun = { ...run, settings, updatedAt: now, profileOverrides: [...new Set([...(run.profileOverrides ?? []), stage])],
        routing: run.routing ? {...run.routing, decision: {...run.routing.decision, assignments: run.routing.decision.assignments.filter(a => a.stage !== stage)}} : undefined };
      if (stage === run.stage) {
        updated.revision++; updated.stageMemory = undefined; updated.workPlan = undefined;
        updated.acceptance = undefined; updated.manualAcceptance = undefined; updated.doctorRepair = undefined;
      }
      this.runs.save(updated);
      this.runs.event(id, 'profile', `Профиль этапа ${stage + 1} (${original.role}) изменён пользователем: ${replacement.runner} · ${selectedModel}. Рабочая ветка и потраченный бюджет сохранены.`, now);
      return this.publicRun(updated);
    });
  }
  public resume(id: string, replacementProfileId?: unknown, replacementModel?: unknown, repair = false, refreshChecks = false, retryCurrent = false): AgentRun {
    return this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    if (run.cleanup) throw new TrackerError('CONFLICT', 'Рабочая копия очищается или уже очищена. Создайте новый запуск.');
    const acceptedMerge = run.status === RunStatus.Review && !!run.acceptedSha && run.acceptedSha === run.commitSha
      && run.stage >= run.settings.pipeline.length && run.settings.mergePolicy === MergePolicy.Local;
    if (!RESUMABLE_RUN_STATUSES.includes(run.status) && !acceptedMerge) throw new TrackerError('CONFLICT', 'Run cannot be resumed.');
    if (this.projects.hasPreviewPatch(run.id)) throw new TrackerError('CONFLICT', 'Сначала откатите патч проверки.');
    const mergeOnly = run.stage >= run.settings.pipeline.length && run.settings.mergePolicy === MergePolicy.Local;
    const budgetReason = RunBudget.reason(run, Date.parse(this.clock.now()));
    if (budgetReason && !mergeOnly) throw new TrackerError('CONFLICT', `${budgetReason} Increase this run budget explicitly, then resume. Spent usage is retained.`);
    if (run.stage >= run.settings.pipeline.length && !mergeOnly) throw new TrackerError('CONFLICT', 'All stages finished; resolve the merge manually.');
    const task = this.tasks.getTaskCard(Decomposition.child(run)?.taskId ?? run.taskId);
    if (task.openQuestionsCount) throw new TrackerError('CONFLICT', 'Answer task questions first.');
    if (task.status === TaskStatus.Done || (task.status === TaskStatus.Review && !mergeOnly)) throw new TrackerError('CONFLICT', 'Task is already complete or in review.');
    if (this.runs.hasActive(run.taskId) && run.status !== RunStatus.Waiting) throw new TrackerError('CONFLICT', 'Task already has another active run.');
    if (run.feature?.children.some(c => this.runs.hasActive(c.taskId))) throw new TrackerError('CONFLICT', 'A child has an independent active run; stop it before resuming the feature.');
    const reroute = !!run.routing && run.routing.sourceDescription !== (task.description ?? '');
    if (reroute && run.feature) throw new TrackerError('CONFLICT', 'Изменились требования декомпозированной фичи: перепроверьте дочерние планы перед продолжением. Рабочие копии сохранены.');
    if (reroute && (replacementProfileId !== undefined || replacementModel !== undefined || retryCurrent)) throw new TrackerError('CONFLICT', 'Изменились требования. Сначала используйте обычное продолжение для повторной маршрутизации.');
    const role = run.settings.agents.find((agent) => agent.id === run.settings.pipeline[run.stage])?.role;
    if (retryCurrent && (!role || !EVIDENCE_AGENT_ROLES.includes(role) || repair || refreshChecks
      || replacementProfileId !== undefined || replacementModel !== undefined)) {
      throw new TrackerError('CONFLICT', 'Повтор доступен только для текущего этапа проверки.');
    }
    const repairStage = repair && !reroute ? this.doctorRepairStage(run) : undefined;
    if (repair && !reroute && (repairStage === undefined || run.proposedFix?.action !== 'repair_stage')) throw new TrackerError('CONFLICT', 'Нет доступного этапа для исправления.');
    if (repair && !reroute) {
      const reason = RunBudget.reason(run, Date.parse(this.clock.now()), true);
      if (reason) throw new TrackerError('CONFLICT', reason);
    }
    const retry = PipelinePolicy.route(run.settings, run.stage)?.retry;
    const manualRetry = !retryCurrent && run.status === RunStatus.Waiting && run.lastRoute?.kind === 'exhausted' && run.lastRoute.from === run.stage && retry;
    const waitingDeveloper = run.status === RunStatus.Waiting && role && EVIDENCE_AGENT_ROLES.includes(role)
      ? Decomposition.child(run)?.developerStage ?? run.feature?.finalDeveloperStage ?? run.settings.pipeline.findIndex((id) => run.settings.agents.find((agent) => agent.id === id)?.role === AgentRole.Developer) : -1;
    const stage = reroute ? run.settings.pipeline.findIndex(id => run.settings.agents.find(a => a.id === id)?.role === AgentRole.Router) : retryCurrent ? run.stage : repairStage ?? (manualRetry ? run.settings.pipeline.indexOf(manualRetry.to) : waitingDeveloper >= 0 ? waitingDeveloper : run.stage);
    if (stage < 0) throw new TrackerError('CONFLICT', 'Для обновления требований нужен этап роутера. Рабочая копия сохранена.');
    let settings = run.settings;
    if (refreshChecks) {
      const project = new AutomationSettingsValidator().validate(this.settings());
      const repository = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/$/, '');
      if (repository(project.repositoryPath) !== repository(settings.repositoryPath) || !project.checks.length) {
        throw new TrackerError('CONFLICT', 'Сохраните обязательные проверки в настройках того же проекта, что и у этого запуска.');
      }
      settings = { ...settings, checks: project.checks };
    }
    if (replacementProfileId !== undefined || replacementModel !== undefined) {
      if (run.status !== RunStatus.Failed || mergeOnly || !role) throw new TrackerError('CONFLICT', 'Only a failed agent stage can switch profiles.');
      const configured = this.settings();
      const replacement = configured.agents.find(agent => agent.id === replacementProfileId && agent.role === role);
      const connection = configured.connections.find(entry => entry.id === replacement?.connectionId);
      if (!replacement || !connection) throw new TrackerError('VALIDATION_FAILED', 'Choose a configured profile for the same role.');
      if (replacementModel !== undefined && (typeof replacementModel !== 'string' || !replacementModel.trim()
        || replacementModel.length > 300 || /[\x00-\x1f]/.test(replacementModel))) throw new TrackerError('VALIDATION_FAILED', 'Invalid replacement model.');
      const current = settings.agents.find(agent => agent.id === settings.pipeline[stage])!;
      const profileId = randomUUID();
      const connectionId = randomUUID();
      const rename = (id: string) => id === current.id ? profileId : id;
      settings = new AutomationSettingsValidator().validate({
        ...settings,
        connections: [...settings.connections, { ...connection, id: connectionId }],
        agents: [...settings.agents, { ...replacement, model: replacementModel ?? replacement.model, id: profileId, connectionId, instructions: current.instructions }],
        pipeline: settings.pipeline.map((agentId, index) => index === stage ? profileId : agentId),
        pipelineRoutes: settings.pipelineRoutes?.map(route => ({ ...route, from: rename(route.from),
          passTo: typeof route.passTo === 'string' ? rename(route.passTo) : route.passTo,
          ...(route.retry ? { retry: { ...route.retry, to: rename(route.retry.to) } } : {}),
        })),
      });
    }
    const updated: AgentRun = { ...run, settings, stage, status: RunStatus.Queued, proposedFix: null, leaseToken: null, workerId: null, leaseUntil: null, updatedAt: this.clock.now(), finishedAt: undefined };
    if (reroute) {
      updated.revision++;
      updated.routing = undefined;
      updated.acceptance = undefined;
      updated.manualAcceptance = undefined;
      updated.stageMemory = undefined;
      updated.workPlan = undefined;
      updated.doctorRepair = undefined;
      updated.routeRetries = undefined;
      updated.planProposal = undefined;
      updated.lastRoute = undefined;
      updated.acceptedSha = undefined;
      updated.summary = 'Требования изменились: повторная маршрутизация и анализ в сохранённой рабочей ветке.';
    }
    updated.retryCurrentStage = retryCurrent ? stage : undefined;
    if (retryCurrent) {
      updated.revision++;
      updated.stageMemory = undefined;
    }
    if (manualRetry && !reroute) updated.revision++;
    if (repairStage !== undefined) {
      updated.revision++;
      updated.doctorRepair = { stage, failedStage: run.stage, revision: updated.revision,
        diagnostic: [run.proposedFix!.title, run.summary.slice(-2400), run.proposedFix!.explanation.slice(0, 1800)].join('\n').slice(0, 4500) };
    }
    this.runs.restore(id);
    this.runs.save(updated);
    this.runs.event(id, 'resumed', reroute ? 'Требования изменились: запуск возвращён к роутеру. Коммиты, рабочая копия и израсходованный бюджет сохранены; прежняя приёмка сброшена.' : retryCurrent ? `Повтор только текущей проверки: этап ${stage + 1}. При замечаниях запуск остановится для решения пользователя.` : refreshChecks ? 'Продолжение в прежней рабочей ветке с обновлёнными проверками проекта.' : repair ? 'Исправление по диагнозу Pipeline Doctor поставлено в очередь.' : manualRetry
      ? `Пользователь продолжил доработку после исчерпания лимита. Следующий этап: ${stage + 1}.` : replacementProfileId === undefined
      ? 'Продолжение с сохранёнными настройками и checkpoint. Ожидает worker.'
      : 'Текущий этап поставлен в очередь с другим профилем агента. Рабочая ветка сохранена.', this.clock.now());
    return this.publicRun(updated);
    });
  }

  public acceptManually(id: string): AgentRun {
    return this.runs.db.transaction(() => {
      const run = this.requireRun(id);
      if (run.manualAcceptance?.sha === run.commitSha && run.status === RunStatus.Review) return this.publicRun(run);
      const task = this.tasks.getTaskCard(run.taskId);
      if (!RESUMABLE_RUN_STATUSES.includes(run.status) || !run.commitSha || !run.checkout || run.cleanup
        || task.status === TaskStatus.Done || task.openQuestionsCount
        || this.runs.list(run.taskId).some(other => other.id !== run.id && ACTIVE_RUN_STATUSES.includes(other.status))) {
        throw new TrackerError('CONFLICT', 'Для ручной приёмки нужен остановленный запуск с сохранённым результатом и отвеченными вопросами.');
      }
      if (task.status !== TaskStatus.Review) {
        if (task.status !== TaskStatus.InProgress && task.status !== TaskStatus.Testing) {
          this.tasks.setStatus({ id: task.id, status: TaskStatus.InProgress, actor: 'user' });
        }
        if (this.tasks.getTaskCard(task.id).status === TaskStatus.InProgress) {
          this.tasks.setStatus({ id: task.id, status: TaskStatus.Testing, actor: 'user' });
        }
        this.tasks.setStatus({ id: task.id, status: TaskStatus.Review, actor: 'user' });
      }
      const now = this.clock.now();
      const summary = 'Результат проверен и принят пользователем вручную. Замечания и непройденные этапы агентов сохранены в журнале.';
      const updated: AgentRun = { ...run, status: RunStatus.Review, manualAcceptance: { at: now, sha: run.commitSha, stage: run.stage },
        summary, acceptedSha: undefined, updatedAt: now, finishedAt: now, workerId: null, leaseToken: null, leaseUntil: null, proposedFix: null, retryCurrentStage: undefined };
      this.tasks.addComment({ id: task.id, text: `${summary} Коммит: ${run.commitSha}. Запуск: ${run.id}.`, actor: 'user' });
      this.runs.restore(id);
      this.runs.save(updated);
      this.runs.event(id, 'manual_acceptance', summary, now);
      return this.publicRun(updated);
    });
  }

  public reviewTask(taskId: string, decision: 'accept' | 'rework', feedback?: unknown): AgentRun {
    return this.runs.db.transaction(() => {
      const task = this.tasks.getTaskCard(taskId);
      const run = this.runs.list(taskId)[0];
      if (run && this.projects.hasPreviewPatch(run.id)) throw new TrackerError('CONFLICT', 'Сначала откатите патч проверки.');
      if (decision === 'accept' && run?.acceptedSha === run?.commitSha && run?.acceptedSha
        && RESUMABLE_RUN_STATUSES.includes(run.status) && run.stage >= run.settings.pipeline.length) {
        return this.resume(run.id);
      }
      if (decision === 'rework' && run && task.status === TaskStatus.InProgress && this.stoppedRework(run)
        && !task.openQuestionsCount && !this.runs.hasActive(taskId)) {
        if (typeof feedback !== 'string' || !feedback.trim()) throw new TrackerError('VALIDATION_FAILED', 'Опишите, что нужно исправить.');
        const now = this.clock.now();
        const reason = RunBudget.reason(run, Date.parse(now), true);
        if (reason) throw new TrackerError('CONFLICT', reason);
        this.tasks.addComment({ id: taskId, text: feedback.trim(), actor: 'user' });
        const attempted = run.usageAttempts?.some(attempt => attempt.stage === run.stage && attempt.revision === run.revision);
        const updated: AgentRun = { ...run, status: RunStatus.Queued, reviewFeedback: feedback.trim(), summary: feedback.trim(),
          revision: run.revision + (attempted ? 1 : 0), stageMemory: undefined, proposedFix: null,
          leaseToken: null, workerId: null, leaseUntil: null, finishedAt: undefined, updatedAt: now };
        this.runs.restore(run.id);
        this.runs.save(updated);
        this.runs.event(run.id, 'resumed', 'Остановленная доработка продолжена с обновлённым замечанием.', now);
        return this.publicRun(updated);
      }
      if (task.status === TaskStatus.Review && run?.status === RunStatus.Merged && !task.openQuestionsCount
        && !this.runs.hasActive(taskId)) {
        if (decision === 'accept') {
          this.tasks.setStatus({ id: taskId, status: TaskStatus.Done, actor: 'user' });
          return this.publicRun(run);
        }
        if (typeof feedback !== 'string' || !feedback.trim()) throw new TrackerError('VALIDATION_FAILED', 'Опишите, что нужно исправить.');
        const stage = run.feature?.finalDeveloperStage ?? run.settings.pipeline.findIndex(agentId =>
          run.settings.agents.some(agent => agent.id === agentId && WRITABLE_AGENT_ROLES.includes(agent.role)));
        if (stage < 0) throw new TrackerError('CONFLICT', 'В запуске нет этапа для доработки.');
        this.tasks.setStatus({ id: taskId, status: TaskStatus.Ready, actor: 'user', comment: feedback.trim() });
        const pipeline = run.settings.pipeline.slice(stage);
        const continuation = this.createRun(taskId, { ...run.settings, pipeline, pipelineRoutes: PipelinePolicy.routesFor(run.settings, pipeline) }, undefined, false);
        const updated = { ...continuation, restartedFromId: run.id, summary: feedback.trim(), reviewFeedback: feedback.trim() };
        this.runs.save(updated);
        this.runs.event(updated.id, 'resumed', 'Доработка ранее слитого результата от текущей базовой ветки.', this.clock.now());
        return this.publicRun(updated);
      }
      if (task.status !== TaskStatus.Review || !run || run.status !== RunStatus.Review || !run.checkout || run.cleanup
        || !run.commitSha || (run.stage < run.settings.pipeline.length && run.manualAcceptance?.sha !== run.commitSha) || !PipelinePolicy.writes(run.settings)
        || task.openQuestionsCount || this.runs.hasActive(taskId)) {
        throw new TrackerError('CONFLICT', 'Нет завершённого агентского запуска, ожидающего приёмки.');
      }
      if (run.routing && run.routing.sourceDescription !== (this.tasks.getTaskCard(taskId).description ?? '')) throw new TrackerError('VALIDATION_FAILED', 'Requirements changed after routing; resume the run to refresh routing in the saved worktree.');
      const now = this.clock.now();
      let updated: AgentRun = { ...run, status: RunStatus.Queued, finishedAt: undefined, updatedAt: now,
        workerId: null, leaseUntil: null, leaseToken: null, proposedFix: null };
      if (decision === 'accept') {
        updated = { ...updated, settings: { ...run.settings, mergePolicy: MergePolicy.Local },
          stage: run.settings.pipeline.length, acceptedSha: run.commitSha, summary: 'Результат принят пользователем. Ожидает слияния.' };
      } else {
        if (typeof feedback !== 'string' || !feedback.trim()) throw new TrackerError('VALIDATION_FAILED', 'Опишите, что нужно исправить.');
        const stage = run.feature?.finalDeveloperStage ?? run.settings.pipeline.findIndex(agentId =>
          run.settings.agents.some(agent => agent.id === agentId && WRITABLE_AGENT_ROLES.includes(agent.role)));
        if (stage < 0) throw new TrackerError('CONFLICT', 'В запуске нет этапа для доработки.');
        const budgetReason = RunBudget.reason(run, Date.parse(now), true);
        if (budgetReason) throw new TrackerError('CONFLICT', budgetReason);
        this.tasks.setStatus({ id: taskId, status: TaskStatus.InProgress, actor: 'user', comment: feedback.trim() });
        updated = { ...updated, manualAcceptance: undefined, acceptedSha: undefined, stage, revision: run.revision + 1, stageMemory: undefined, summary: feedback.trim(), reviewFeedback: feedback.trim() };
      }
      this.runs.restore(run.id);
      this.runs.save(updated);
      this.runs.event(run.id, 'resumed', decision === 'accept' ? updated.summary : 'Пользователь вернул задачу на доработку в прежней ветке.', now);
      return this.publicRun(updated);
    });
  }

  public stageSkills(id: string, token: string) {
    const run = this.owned(id, token);
    if (!run.settings.pipeline[run.stage]) return [];
    const role = TaskRouting.profile(run.settings, run.stage, run.routing).role;
    const bindings = run.settings.skillBindings ?? [];
    return (run.skillVersions ?? []).filter(ref => bindings.some(b => b.skillId === ref.id && b.roles.includes(role)))
      .map(ref => this.skillLibrary.read(ref));
  }
  public reviewEvidence(id: string, token: string): { name: string; base64: string }[] {
    const run = this.owned(id, token);
    return (run.reviewFeedback ?? '').split('\n').flatMap(line => {
      const match = COMMENT_SCREENSHOT.exec(line);
      return match && (!match[3] || match[3] === encodeURIComponent(this.workspace)) ? [match[2]] : [];
    }).slice(0, SCREENSHOT_LIMIT).flatMap(name => {
      const file = this.images?.resolveFile(name);
      return file && statSync(file).size <= SCREENSHOT_MAX_BYTES ? [{ name, base64: readFileSync(file).toString('base64') }] : [];
    });
  }

  public requestDiff(id: string, wholeRun: boolean) {
    const run = this.requireRun(id);
    const head = run.commitSha;
    const base = wholeRun ? run.checkout?.baseSha : undefined;
    if (!head || (wholeRun && !base)) throw new TrackerError('CONFLICT', 'Для этого сравнения пока нет сохранённых коммитов.');
    return this.projects.enqueue({ action: ProjectAction.Diff, path: run.checkout?.repositoryRoot ?? run.settings.repositoryPath, diff: { head, base } }, true);
  }

  private canPreviewPatch(run: AgentRun): boolean {
    return !!run.commitSha && !!run.checkout && run.commitSha !== run.checkout.baseSha && !run.cleanup && !run.acceptedSha
      && (run.status === RunStatus.Review || RESUMABLE_RUN_STATUSES.includes(run.status))
      && this.tasks.getTaskCard(run.taskId).status !== TaskStatus.Done
      && !this.runs.list(run.taskId).some(other => other.id !== run.id && ACTIVE_RUN_STATUSES.includes(other.status));
  }

  public requestPreviewPatch(taskId: string, rollback: boolean, deploy = false, runId?: string) {
    return this.runs.db.transaction(() => {
      const run = runId ? this.requireRun(runId) : this.runs.list(taskId)[0];
      if (!run || run.taskId !== taskId || !run.commitSha || !run.checkout
        || (!rollback && !this.canPreviewPatch(run))) {
        throw new TrackerError('CONFLICT', 'Для примерки нужен остановленный запуск с сохранённым коммитом и рабочей копией.');
      }
      const deployment = deploy ? this.settings().postOperations : undefined;
      if (deploy && !deployment?.length) throw new TrackerError('VALIDATION_FAILED', 'Настройте команды в «Проект и проверки → Пост-операции».');
      if (this.projects.previewPatchPending(run.id)) throw new TrackerError('CONFLICT', 'Операция с патчем уже выполняется.');
      if (!rollback && this.projects.hasPreviewPatch(run.id)) throw new TrackerError('CONFLICT', 'Патч уже примеряется или накатан.');
      return this.projects.enqueue({ action: ProjectAction.PreviewPatch, path: run.checkout.repositoryRoot,
        previewPatch: { runId: run.id, head: run.commitSha, branch: run.settings.baseBranch, rollback, deployment } }, true);
    });
  }

  public previewPatchActive(taskId: string): boolean {
    this.tasks.getTaskCard(taskId);
    const run = this.runs.list(taskId)[0];
    return !!run && this.projects.hasPreviewPatch(run.id);
  }
  public acceptanceState(taskId: string): { status: RunStatus; summary: string } | null {
    const run = this.runs.list(taskId)[0];
    return run?.acceptedSha && run.acceptedSha === run.commitSha && run.status !== RunStatus.Review
      ? { status: run.status, summary: run.summary } : null;
  }
  public canResumeRework(taskId: string): boolean {
    const task = this.tasks.getTaskCard(taskId);
    const run = this.runs.list(taskId)[0];
    return task.status === TaskStatus.InProgress && !task.openQuestionsCount && !!run
      && this.stoppedRework(run) && !this.runs.hasActive(taskId);
  }
  private stoppedRework(run: AgentRun): boolean {
    return RESUMABLE_RUN_STATUSES.includes(run.status) && !!run.reviewFeedback && !!run.checkout && !run.cleanup
      && run.stage < run.settings.pipeline.length;
  }
  /** Explicit UI action only: no MCP tool allows agents to raise their budget. */
  public extendBudget(id: string, input: unknown): AgentRun {
    return this.runs.db.transaction(() => {
      const run = this.requireRun(id);
      if (!RESUMABLE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Stop the run before changing its budget.');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TrackerError('VALIDATION_FAILED', 'Only run budget limits can be changed.');
      const settings = { ...run.settings };
      const changes: string[] = [];
      for (const [key, value] of Object.entries(input)) {
        const field = RUN_BUDGET_FIELDS.find(entry => entry.key === key);
        if (!field) throw new TrackerError('VALIDATION_FAILED', 'Only run budget limits can be changed.');
        const previous = RunBudget.value(run, field);
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < field.min || value > field.max) {
          throw new TrackerError('VALIDATION_FAILED', `${field.label} — введите целое число от ${field.min} до ${field.max}.`);
        }
        if (value === previous) continue;
        if (RunBudget.calculated(run, field.key)) throw new TrackerError('VALIDATION_FAILED', 'Число вызовов и резерв доработок этой фичи определены планом.');
        if (value < previous) throw new TrackerError('VALIDATION_FAILED', 'Existing run limits can only increase.');
        settings[field.key] = value;
        changes.push(`${field.label}: ${previous} → ${value}`);
      }
      if (!changes.length) return this.publicRun(run);
      const { maxAgentCalls, maxInputTokens, maxRunMinutes, maxStageToolCalls, timeoutMinutes, maxRevisions } = run.settings;
      const checkpointBudgets = { maxRevisions, ...(run.checkpointBudgets ?? { maxAgentCalls, maxInputTokens, maxRunMinutes, maxStageToolCalls, timeoutMinutes }) };
      const updated = { ...run, settings, checkpointBudgets, updatedAt: this.clock.now() };
      this.runs.save(updated);
      this.runs.event(id, 'budget', changes.join(', '), updated.updatedAt);
      return this.publicRun(updated);
    });
  }
  private owned(id: string, token: string): AgentRun {
    const run = this.requireRun(id);
    if (![RunStatus.Running, RunStatus.Integrating].includes(run.status as 'running' | 'integrating') || !token || token !== run.leaseToken || !run.leaseUntil || run.leaseUntil < this.clock.now()) throw new TrackerError('CONFLICT', 'Run lease is missing, expired or cancelled.');
    if (run.status === RunStatus.Integrating) {
      const status = this.tasks.getTaskCard(run.taskId).status;
      if (status !== TaskStatus.Review && !(run.mergeReviewRequired && status === TaskStatus.Testing)) throw new TrackerError('CONFLICT', 'Task changed during integration; inspect its requirements before merging.');
    }
    return run;
  }
  public cleanup(id: string, discard = false) {
    return this.runs.db.transaction(() => {
      const run = this.requireRun(id);
      if (ACTIVE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Сначала остановите запуск.');
      if (run.cleanup?.state === 'completed') return run.cleanup;
      if (run.cleanup?.state === 'queued') {
        const job = this.projects.get(run.cleanup.requestId!);
        if (job.status === 'queued' || job.status === 'running') return run.cleanup;
      }
      if (!run.checkout && !run.attemptStartedAt) {
        const cleanup = { state: 'completed' as const, result: { paths: [], branches: [], retainedBranches: [] } };
        this.runs.save({ ...run, cleanup }); return cleanup;
      }
      if (run.status !== RunStatus.Merged && !discard) throw new TrackerError('CONFLICT', 'Запуск не слит автоматически. Подтвердите удаление неперенесённых изменений.');
      const workspace = this.workspace;
      const request = this.projects.enqueue({ action: ProjectAction.Cleanup, path: run.settings.repositoryPath, cleanup: {
        runId: run.id, workspace, repository: run.settings.repositoryPath, directory: run.checkout?.worktreePath,
        baseBranch: run.settings.baseBranch, sourceSha: run.commitSha ?? undefined, candidateSha: run.integration?.candidateSha,
        children: run.feature?.children.map(c => ({ key: c.key, sourceSha: c.sourceSha, mergedSha: c.mergedSha })) ?? [], merged: run.status === RunStatus.Merged, discard,
      } }, true);
      const cleanup = { state: 'queued' as const, requestId: request.id };
      this.runs.save({ ...run, cleanup }); this.runs.event(id, 'cleanup', 'Очистка рабочих копий поставлена в очередь host worker.', this.clock.now());
      return cleanup;
    });
  }
  public completeHost(id: string, token: string, result?: ProjectResult, error?: string): void {
    this.runs.db.transaction(() => {
      const request = this.projects.get(id);
      this.projects.complete(id, token, result, error);
      if (request.action !== ProjectAction.Cleanup || !request.cleanup) return;
      const run = this.requireRun(request.cleanup.runId);
      if (run.cleanup?.requestId !== id) throw new TrackerError('CONFLICT', 'Устаревший результат очистки.');
      const failure = error ?? (!result?.cleanup ? 'Worker не подтвердил очистку.' : undefined);
      this.runs.save({ ...run, cleanup: { state: failure ? 'failed' : 'completed', requestId: id, error: failure, result: result?.cleanup } });
      this.runs.event(run.id, 'cleanup', failure ? `Очистка не завершена: ${failure}` : 'Временные рабочие копии очищены; история и отчёты сохранены.', this.clock.now());
      if (!failure) this.runs.archive(run.id, this.clock.now());
    });
  }
  public deleteRun(id: string, force = false): void {
    this.runs.db.transaction(() => {
      const run = this.runs.get(id); if (!run) return;
      if (ACTIVE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Активный запуск нельзя удалить.');
      if (!force && (run.checkout || run.attemptStartedAt) && run.cleanup?.state !== 'completed') throw new TrackerError('CONFLICT', 'Сначала очистите рабочую копию. История пока сохранена.');
      if (run.cleanup?.requestId) {
        try {
          const req = this.projects.get(run.cleanup.requestId);
          if (req && (req.status === 'queued' || req.status === 'running')) {
            this.projects.complete(run.cleanup.requestId, req.token ?? '', undefined, 'Запуск удален пользователем.');
          }
        } catch {}
      }
      const retained = run.cleanup?.result?.retainedBranches ?? [];
      this.tasks.addComment({ id: run.taskId, text: `История запуска ${id} удалена пользователем. Карточка и отчёты сохранены.${retained.length ? ` Сохранённые ветки: ${retained.join(', ')}.` : ''}`, kind: 'note', actor: 'agent' });
      this.runs.delete(id);
    });
  }
  public merged(id: string, token: string): void {
    this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    this.owned(id, token);
    if (run.status !== RunStatus.Integrating || run.integration?.state !== 'publishing') throw new TrackerError('CONFLICT', 'Merge publication is not owned by this worker.');
    if (run.mergeReviewRequired) this.tasks.setStatus({ id: run.taskId, status: TaskStatus.Review, actor: 'agent' });
    const accepted = run.acceptedSha === run.commitSha && !!run.acceptedSha;
    if (accepted && this.tasks.getTaskCard(run.taskId).status === TaskStatus.Review) {
      this.tasks.setStatus({ id: run.taskId, status: TaskStatus.Done, actor: 'user' });
    }
    const now = this.clock.now();
    const evidence = `${run.branch}@${run.commitSha} -> ${run.integration.targetBranch}@${run.integration.candidateSha}`;
    this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
      summary: `Squash merged: ${evidence}`,
      integration: { ...run.integration, state: 'merged' }, status: RunStatus.Merged, leaseToken: null, updatedAt: now, finishedAt: now });
    this.runs.event(id, 'merged', evidence, now);
    this.tasks.addComment({ id: run.taskId, text: `[AUTOMATION MERGED] ${evidence}. Integration completed.`, actor: 'agent' });
    });
    try { this.cleanup(id); } catch (error) {
      const run = this.requireRun(id);
      const message = String(error);
      this.runs.save({ ...run, cleanup: { state: 'failed', error: message } });
    }
  }
  private publicRun(run: AgentRun): AgentRun { return { ...run, leaseToken: null }; }
  private refreshCleanup(run: AgentRun): AgentRun {
    if (run.cleanup?.state !== 'queued' || !run.cleanup.requestId) return run;
    let failure: string | undefined;
    try { const job = this.projects.get(run.cleanup.requestId); if (job.status === 'failed') failure = job.error ?? 'Запрос очистки истёк.'; }
    catch { failure = 'Запрос очистки больше не доступен; повторите очистку.'; }
    if (!failure) return run;
    const updated: AgentRun = { ...run, cleanup: { ...run.cleanup, state: 'failed', error: failure } };
    this.runs.save(updated); return updated;
  }
  private expireLeases(): void {
    const now = this.clock.now();
    for (const run of this.runs.running()) {
      if ((run.status === RunStatus.Running || run.status === RunStatus.Integrating) && run.leaseUntil && run.leaseUntil < now) {
        this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(run.leaseUntil)), budgetUpdatedAt: now,
          integration: run.integration ? { ...run.integration, state: 'blocked', error: 'Worker lease expired; verify its process before resuming.' } : undefined,
          status: run.status === RunStatus.Integrating ? RunStatus.MergeBlocked : RunStatus.Interrupted, leaseToken: null, updatedAt: now, finishedAt: now, summary: 'Worker lease expired. Resume explicitly after checking its process.' });
        this.runs.event(run.id, RunStatus.Interrupted, 'Worker lease expired; no automatic duplicate execution.', now);
      }
    }
  }
  private requireRun(id: string): AgentRun {
    const run = this.runs.get(id);
    if (!run) throw new TrackerError('TASK_NOT_FOUND', 'Agent run not found.');
    return this.refreshCleanup(run);
  }

  public async diagnoseFix(id: string): Promise<ProposedFix> {
    const run = this.requireRun(id);
    if (!RESUMABLE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Анализ доступен после остановки запуска.');
    const occurrence = this.runs.latestOccurrence(id);
    const origin = occurrence && this.runs.eventById(id, occurrence.eventId);
    const events = this.runs.events(id).map(e => e.text);
    if (origin && !events.includes(origin.text)) events.unshift(origin.text);
    const fix = await this.doctor.diagnose(run, events);
    if (fix.diagnosis?.confidence !== 'unknown' && fix.action === 'advice_only' && this.doctorRepairStage(run) !== undefined) fix.action = 'repair_stage';
    return this.runs.db.transaction(() => {
      const current = this.requireRun(id);
      if (current.status !== run.status || current.updatedAt !== run.updatedAt || current.revision !== run.revision
        || this.runs.latestOccurrence(id)?.eventId !== occurrence?.eventId)
        throw new TrackerError('CONFLICT', 'Запуск изменился во время диагностики.');
      if (occurrence) {
        fix.occurrenceEventId = occurrence.eventId;
        this.improvements.recommend(occurrence, `${fix.title}. ${fix.explanation}`);
      }
      this.runs.save({ ...current, proposedFix: fix });
      return fix;
    });
  }

  private doctorRepairStage(run: AgentRun): number | undefined {
    if (run.status !== RunStatus.Failed || !run.checkout || run.feature || run.cleanup ||
      run.stage >= run.settings.pipeline.length || run.revision >= run.settings.maxRevisions) return undefined;
    const failedRole = run.settings.agents.find(agent => agent.id === run.settings.pipeline[run.stage])?.role;
    if (!failedRole || (!WRITABLE_AGENT_ROLES.includes(failedRole) && !EVIDENCE_AGENT_ROLES.includes(failedRole))) return undefined;
    for (let stage = run.stage; stage >= 0; stage--) {
      const role = run.settings.agents.find(agent => agent.id === run.settings.pipeline[stage])?.role;
      if (role && WRITABLE_AGENT_ROLES.includes(role)) return stage;
    }
    return undefined;
  }

  public async applyFix(id: string): Promise<AgentRun> {
    const run = this.requireRun(id);
    if (!run.proposedFix) throw new TrackerError('CONFLICT', 'Нет предложенного исправления.');
    if (!RESUMABLE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Сначала остановите запуск.');
    if (run.proposedFix.action === 'repair_stage') return this.resume(id, undefined, undefined, true);
    if (run.proposedFix.action === 'retry_stage') return this.resume(id);
    await this.doctor.apply(run, run.proposedFix);
    const now = this.clock.now();
    const updated: AgentRun = { ...run, proposedFix: null, updatedAt: now, summary: `Применено авто-исправление: ${run.proposedFix.title}` };
    this.runs.save(updated);
    this.runs.event(id, 'resumed', `Применено авто-исправление: ${run.proposedFix.title}. Запуск готов к продолжению.`, now);
    return this.publicRun(updated);
  }

  public async discardFix(id: string): Promise<AgentRun> {
    const run = this.requireRun(id);
    const now = this.clock.now();
    const updated: AgentRun = { ...run, proposedFix: null, updatedAt: now };
    this.runs.save(updated);
    this.runs.event(id, 'cancelled', 'Предложение диагностики отклонено.', now);
    return this.publicRun(updated);
  }

}
