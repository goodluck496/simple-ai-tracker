import { randomUUID } from 'node:crypto';
import { DEFAULT_AUTOMATION_SETTINGS, AgentRole, RunStatus, AgentVerdict, AUTOMATION_START_TASK_STATUSES, ACTIVE_RUN_STATUSES,
  RESUMABLE_RUN_STATUSES, OWNED_RUN_STATUSES, WRITABLE_AGENT_ROLES, EVIDENCE_AGENT_ROLES, AGENT_VERDICTS, AUTOMATION_TIMING, MergePolicy,
  type AgentOutcome, type AgentRun, type AutomationSettings, type IntegrationInfo } from '../../../shared/automation/contracts.js';
import { TaskStatus } from '../../../shared/tasks/status.js';
import type { Repositories } from '../domain/ports.js';
import type { Clock, TaskService } from '../services/task-service.js';
import { TrackerError } from '../core/errors.js';
import { AutomationSettingsValidator } from './settings.js';
import { AgentRunRepository } from './run-repository.js';
import { ProjectRequests } from './project-requests.js';
import { RunPhase, RUN_PHASES, RunProgressText, type QueueItem, type QueueSnapshot } from '../../../shared/automation/queue.js';
import { TokenMeter, type TokenUsage, type UsageAttempt } from '../../../shared/automation/token-usage.js';
import { RunBudget } from '../../../shared/automation/budget.js';

const SETTINGS_KEY = 'automation_settings_v1';
const LEASE_MS = AUTOMATION_TIMING.leaseMs;

export class AutomationService {
  public get projects(): ProjectRequests { return new ProjectRequests(this.repos.meta, this.runs.db); }
  public constructor(private readonly runs: AgentRunRepository, private readonly repos: Repositories,
    private readonly tasks: TaskService, private readonly clock: Clock) {}

  public settings(): AutomationSettings {
    const value = this.repos.meta.get(SETTINGS_KEY);
    return value ? { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), ...JSON.parse(value) } as AutomationSettings : structuredClone(DEFAULT_AUTOMATION_SETTINGS);
  }
  public configure(input: unknown): AutomationSettings {
    const settings = new AutomationSettingsValidator().validate(input);
    this.repos.meta.set(SETTINGS_KEY, JSON.stringify(settings));
    return settings;
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
  public detail(id: string) {
    return this.runs.db.transaction(() => { this.expireLeases(); return { run: this.publicRun(this.requireRun(id)), events: this.runs.events(id) }; });
  }

  public activeTaskIds(): string[] { return this.runs.activeTaskIds(); }
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
  public integration(id: string, token: string, input: unknown): void {
    this.runs.db.transaction(() => {
      const run = this.owned(id, token); const value = input as IntegrationInfo;
      if (run.status !== RunStatus.Integrating || !value || !['preparing', 'resolving', 'checking', 'ready', 'publishing', 'merged', 'blocked'].includes(value.state)
        || value.sourceSha !== run.commitSha || !/^[a-f0-9]{40,64}$/.test(value.baseSha)
        || (value.candidateSha !== undefined && !/^[a-f0-9]{40,64}$/.test(value.candidateSha))
        || value.targetBranch !== run.settings.baseBranch || typeof value.worktreePath !== 'string' || value.worktreePath.length > 2048
        || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > (run.settings.maxMergeAttempts ?? 2)) throw new TrackerError('VALIDATION_FAILED', 'Invalid integration metadata.');
      if ((value.state === 'ready' || value.state === 'publishing') && !value.candidateSha) throw new TrackerError('VALIDATION_FAILED', 'Verified candidate SHA is required.');
      const now = this.clock.now();
      this.runs.save({ ...run, phase: RunPhase.Merge, phaseStartedAt: run.phase === RunPhase.Merge ? run.phaseStartedAt : now,
        integration: { state: value.state, sourceSha: value.sourceSha, baseSha: value.baseSha, candidateSha: value.candidateSha,
          targetBranch: value.targetBranch, worktreePath: value.worktreePath, attempt: value.attempt, noChanges: !!value.noChanges,
          error: typeof value.error === 'string' ? value.error.slice(0, 3000) : undefined } });
      this.runs.event(id, 'integration', `${value.state}: ${value.targetBranch} · ${value.candidateSha ?? value.baseSha}`, now);
    });
  }
  public enqueue(taskId: string, draft?: unknown, persistSettings = true): AgentRun {
    return this.createRun(taskId, draft, undefined, persistSettings);
  }
  private createRun(taskId: string, draft?: unknown, previous?: AgentRun, persistSettings = true): AgentRun {
    return this.runs.db.transaction(() => {
      const task = this.tasks.getTaskCard(taskId);
      if (task.openQuestionsCount || task.status === TaskStatus.Done) throw new TrackerError('CONFLICT', 'Resolve task questions before starting automation.');
      const integrationRestart = previous && previous.stage >= previous.settings.pipeline.length && previous.settings.mergePolicy === MergePolicy.Local;
      if (!AUTOMATION_START_TASK_STATUSES.includes(task.status) && !(previous && (task.status === TaskStatus.InProgress || task.status === TaskStatus.Testing || (integrationRestart && task.status === TaskStatus.Review)))) throw new TrackerError('CONFLICT', 'Start a new run from backlog, planning or ready; resume an existing run for work already in progress.');
      const settings = new AutomationSettingsValidator().validate(draft === undefined ? this.settings() : draft);
      if (integrationRestart && (settings.repositoryPath.replace(/\\/g, '/') !== previous.settings.repositoryPath.replace(/\\/g, '/')
        || settings.baseBranch !== previous.settings.baseBranch || settings.mergePolicy !== MergePolicy.Local)) throw new TrackerError('CONFLICT', 'Integration restart must keep the source repository, target branch and local merge policy.');
      if (!settings.repositoryPath || !settings.pipeline.length || !settings.checks.length) throw new TrackerError('VALIDATION_FAILED', 'Configure repository, pipeline and real check commands first.');
      const roles = settings.pipeline.map((id) => settings.agents.find((agent) => agent.id === id)!.role);
      const developer = roles.indexOf(AgentRole.Developer);
      const tester = roles.indexOf(AgentRole.Tester);
      const reviewer = roles.indexOf(AgentRole.Reviewer);
      if (roles.filter((role) => role === AgentRole.Analyst).length > 1 || (roles.includes(AgentRole.Analyst) && roles[0] !== AgentRole.Analyst)) throw new TrackerError('VALIDATION_FAILED', 'Optional analyst must be the first stage.');
      if (roles.includes(AgentRole.VisualValidator) && !settings.artifactPaths.some((file) => /\.(png|jpe?g|webp)$/i.test(file))) throw new TrackerError('VALIDATION_FAILED', 'Visual validator requires image artifact paths.');
      if (developer < 0 || tester <= developer || reviewer <= tester) throw new TrackerError('VALIDATION_FAILED', 'Pipeline must include developer, tester and reviewer in this order.');
      const lastTester = roles.lastIndexOf(AgentRole.Tester);
      if (reviewer < lastTester || roles.some((role, index) => (WRITABLE_AGENT_ROLES.includes(role) && index > tester)
        || (role === AgentRole.VisualValidator && index < lastTester))) throw new TrackerError('VALIDATION_FAILED', 'Development/design must precede tests; review and visual validation must follow tests.');
      if (!task.plan && (roles.indexOf(AgentRole.Analyst) < 0 || roles.indexOf(AgentRole.Analyst) > developer)) throw new TrackerError('VALIDATION_FAILED', 'Task needs an existing plan or an analyst before development.');
      if (!task.plan && roles.some((role, index) => role === AgentRole.Designer && index < roles.indexOf(AgentRole.Analyst))) throw new TrackerError('VALIDATION_FAILED', 'Analyst must precede design changes when the task has no plan.');
      if (this.runs.hasActive(taskId)) throw new TrackerError('CONFLICT', 'Task already has an active run.');
      const now = this.clock.now();
      const run: AgentRun = { id: randomUUID(), taskId, status: RunStatus.Queued, stage: 0, revision: 0,
        workerId: null, leaseToken: null, leaseUntil: null, settings, createdAt: now, updatedAt: now,
        branch: null, commitSha: null, summary: '', restartedFromId: previous?.id, usageAttempts: [] };
      if (integrationRestart) {
        run.stage = settings.pipeline.length; run.integrationSourceSha = previous.commitSha!;
        run.commitSha = previous.commitSha; run.mergeMessage = previous.mergeMessage;
      }
      this.runs.save(run);
      this.runs.event(run.id, RunStatus.Queued, 'Run queued with an immutable settings snapshot.', now);
      if (draft !== undefined && persistSettings) this.repos.meta.set(SETTINGS_KEY, JSON.stringify(settings));
      return this.publicRun(run);
    });
  }
  public restart(id: string): AgentRun {
    return this.runs.db.transaction(() => {
      this.expireLeases();
      const previous = this.requireRun(id);
      if (!RESUMABLE_RUN_STATUSES.includes(previous.status)) throw new TrackerError('CONFLICT', 'Остановите текущий запуск перед повторным запуском.');
      if (this.tasks.getTaskCard(previous.taskId).openQuestionsCount) throw new TrackerError('CONFLICT', 'Сначала ответьте на вопросы в карточке задачи.');
      if (previous.status === RunStatus.Waiting) this.runs.save({ ...previous, status: RunStatus.Cancelled, leaseToken: null, updatedAt: this.clock.now() });
      const next = this.createRun(previous.taskId, this.settings(), previous);
      this.runs.event(previous.id, 'restarted', `Новый запуск с начала: ${next.id}. Используются сохранённые настройки команды.`, this.clock.now());
      return next;
    });
  }
  public queue(): QueueSnapshot {
    return this.runs.db.transaction(() => {
      this.expireLeases();
      const runs = this.runs.queue();
      const queued = runs.filter((run) => run.status === RunStatus.Queued).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      const items: QueueItem[] = runs.map((run) => {
        const task = this.tasks.getTaskCard(run.taskId);
        const otherActive = runs.some((other) => other.taskId === run.taskId && other.id !== run.id && ACTIVE_RUN_STATUSES.includes(other.status));
        const actionReason = task.openQuestionsCount ? 'Ответьте на вопросы в карточке задачи.' : otherActive ? 'У задачи есть другой активный запуск.'
          : task.status === TaskStatus.Done || (task.status === TaskStatus.Review && !(run.stage >= run.settings.pipeline.length && run.settings.mergePolicy === MergePolicy.Local)) ? 'Задача уже на проверке или завершена.' : '';
        const resumable = RESUMABLE_RUN_STATUSES.includes(run.status) && (run.stage < run.settings.pipeline.length || run.settings.mergePolicy === MergePolicy.Local);
        return { id: run.id, taskId: run.taskId, title: task.title, taskStatus: task.status, status: run.status, stage: run.stage, revision: run.revision,
          pipeline: run.settings.pipeline.map((id) => { const agent = run.settings.agents.find((a) => a.id === id)!; return { role: agent.role, runner: agent.runner, model: agent.model }; }),
          phase: run.phase, phaseStartedAt: run.phaseStartedAt, heartbeatAt: run.heartbeatAt ?? (run.leaseUntil ? new Date(Date.parse(run.leaseUntil) - LEASE_MS).toISOString() : undefined),
          progressAt: run.progressAt, lastMessage: run.lastMessage ?? '', createdAt: run.createdAt, updatedAt: run.updatedAt, summary: run.summary,
          workerId: run.workerId, branch: run.branch, checkout: run.checkout, integration: run.integration, integrationSourceSha: run.integrationSourceSha, restartedFromId: run.restartedFromId, openQuestions: task.openQuestionsCount,
          attemptStartedAt: run.attemptStartedAt, timeoutMinutes: run.settings.timeoutMinutes, tokenUsage: TokenMeter.summary(run.usageAttempts, run.usageIncomplete),
          queuePosition: run.status === RunStatus.Queued ? queued.findIndex((r) => r.id === run.id) + 1 : undefined,
          canResume: resumable && !actionReason, canRestart: RESUMABLE_RUN_STATUSES.includes(run.status) && !actionReason, actionReason };
      });
      return { items, host: this.projects.status(), serverTime: this.clock.now() };
    });
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
        leaseUntil: new Date(new Date(now).getTime() + LEASE_MS).toISOString(), updatedAt: now, heartbeatAt: now, phase: RunPhase.Preparing,
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
    if (resolver && (run.usageAttempts ?? []).filter(a => a.kind === 'resolver').length >= (run.settings.maxResolverCalls ?? 1)) throw new TrackerError('CONFLICT', 'Conflict resolver call budget exhausted.');
    const agent = run.settings.agents.find((entry) => resolver ? entry.role === AgentRole.Developer : entry.id === run.settings.pipeline[run.stage]);
    if (!agent) throw new TrackerError('CONFLICT', 'Pipeline has no current stage.');
    const task = this.tasks.getTaskCard(run.taskId);
    if (task.openQuestionsCount) throw new TrackerError('CONFLICT', 'Task has unanswered questions.');
    if (agent.role === AgentRole.Analyst) this.tasks.setStatus({ id: task.id, status: TaskStatus.Planning, actor: 'agent' });
    if (agent.role === AgentRole.Developer && !resolver) this.tasks.setStatus({ id: task.id, status: TaskStatus.InProgress, actor: 'agent' });
    if (agent.role === AgentRole.Tester && task.status !== TaskStatus.Testing) this.tasks.setStatus({ id: task.id, status: TaskStatus.Testing, actor: 'agent' });
    const now = this.clock.now();
    const attempt: UsageAttempt = { id: randomUUID(), kind: resolver ? 'resolver' : 'pipeline', stage: run.stage, revision: run.revision, role: agent.role, runner: agent.runner, model: agent.model,
      startedAt: now, updatedAt: now, finished: false };
    const legacyUsageMissing = run.usageAttempts === undefined && (run.stage > 0 || run.revision > 0 || this.runs.events(id).some((event) => event.kind === 'stage'));
    this.runs.save({ ...run, phase: RunPhase.Agent, phaseStartedAt: now, updatedAt: now, lastMessage: '',
      usageIncomplete: run.usageIncomplete || legacyUsageMissing, usageAttempts: [...(run.usageAttempts ?? []), attempt] });
    this.runs.event(id, 'stage', `${agent.role}: ${agent.runner} / ${agent.model}`, this.clock.now());
    return attempt.id;
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
        if (sample.inputTokens < attempt.usage.inputTokens || sample.outputTokens < attempt.usage.outputTokens
          || sample.reportedRequests < attempt.usage.reportedRequests || sample.missingRequests < attempt.usage.missingRequests) return;
      }
      const now = this.clock.now();
      this.runs.save({ ...run, usageAttempts: attempts.map((a) => a.id !== attemptId ? a : { ...a, updatedAt: now,
        finished: a.finished || finished, usage: sample ?? a.usage }) });
    });
  }
  public completeStage(id: string, token: string, outcome: AgentOutcome, branch: string, commitSha: string): AgentRun {
    return this.runs.db.transaction(() => {
      const run = this.owned(id, token);
      if (run.status !== RunStatus.Running) throw new TrackerError('CONFLICT', 'Pipeline is already complete.');
      if (!outcome || !AGENT_VERDICTS.includes(outcome.verdict) || typeof outcome.summary !== 'string') throw new TrackerError('VALIDATION_FAILED', 'Invalid agent verdict.');
      if (!/^[a-f0-9]{40,64}$/.test(commitSha) || !/^sat\/[\w-]+$/.test(branch)) throw new TrackerError('VALIDATION_FAILED', 'Worker must provide branch and commit SHA.');
      const profile = run.settings.agents.find((agent) => agent.id === run.settings.pipeline[run.stage])!;
      const now = this.clock.now();
      let updated: AgentRun = { ...run, branch, commitSha, updatedAt: now, summary: outcome.summary,
        budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now };
      if (WRITABLE_AGENT_ROLES.includes(profile.role) && typeof outcome.commitMessage === 'string') updated.mergeMessage = outcome.commitMessage;
      if (EVIDENCE_AGENT_ROLES.includes(profile.role)) {
        this.tasks.addAttachment(run.taskId, { kind: 'report', name: `${profile.role}-${run.id}-${run.revision}.md`,
          content: `# ${profile.role}\n\nVerdict: ${outcome.verdict}\nCommit: ${commitSha}\nBranch: ${branch}\n\n${outcome.summary}\n\n## Worker evidence\n${this.runs.events(id).filter((event) => event.kind === 'progress').slice(-10).map((event) => event.text).join('\n')}` });
      }
      const budgetReason = RunBudget.reason(run, Date.parse(now));
      if (budgetReason || outcome.verdict === AgentVerdict.Blocked
        || (outcome.verdict === AgentVerdict.ChangesRequested && WRITABLE_AGENT_ROLES.includes(profile.role))) {
        updated = { ...updated, status: RunStatus.Failed, leaseToken: null,
          summary: budgetReason ?? `Execution blocked; no automatic retry: ${outcome.summary}` };
      } else if (outcome.verdict === AgentVerdict.Questions) {
        if (!Array.isArray(outcome.questions) || !outcome.questions.length || !outcome.questions.every((question) => typeof question === 'string' && question.trim())) throw new TrackerError('VALIDATION_FAILED', 'Questions verdict requires questions.');
        this.tasks.askQuestions({ id: run.taskId, questions: outcome.questions, actor: 'agent' });
        updated = { ...updated, status: RunStatus.Waiting, leaseToken: null };
      } else if (outcome.verdict === AgentVerdict.ChangesRequested) {
        if (profile.role === AgentRole.Analyst) throw new TrackerError('VALIDATION_FAILED', 'Analyst must return a plan or questions.');
        const developer = run.settings.pipeline.findIndex((profileId) => run.settings.agents.find((agent) => agent.id === profileId)?.role === AgentRole.Developer);
        updated = run.revision >= run.settings.maxRevisions ? { ...updated, status: RunStatus.Failed, leaseToken: null }
          : { ...updated, stage: developer, revision: run.revision + 1 };
      } else {
        if (profile.role === AgentRole.Analyst) {
          if (!outcome.plan?.trim()) throw new TrackerError('VALIDATION_FAILED', 'Analyst must return a plan.');
          this.tasks.attachPlan({ id: run.taskId, planContent: outcome.plan, summary: outcome.summary, actor: 'agent' });
        }
        updated = { ...updated, stage: run.stage + 1 };
        if (updated.stage >= run.settings.pipeline.length) {
          this.tasks.setStatus({ id: run.taskId, status: TaskStatus.Review, actor: 'agent' });
          updated = { ...updated, status: run.settings.mergePolicy === MergePolicy.Local ? RunStatus.Integrating : RunStatus.Review,
            leaseToken: run.settings.mergePolicy === MergePolicy.Local ? run.leaseToken : null };
        }
      }
      this.runs.save(updated);
      this.runs.event(id, updated.status === RunStatus.Failed ? 'failed' : outcome.verdict, updated.summary, now);
      this.tasks.addComment({ id: run.taskId, text: `[AGENT ${profile.role}] ${outcome.summary}\nBranch: ${branch}\nCommit: ${commitSha}`, kind: 'note', actor: 'agent' });
      return updated;
    });
  }
  public fail(id: string, token: string, message: string): void {
    return this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    if (!token || run.leaseToken !== token || !OWNED_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Run is no longer owned by this worker.');
    const now = this.clock.now();
    this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(now)), budgetUpdatedAt: now,
      status: run.status === RunStatus.Integrating ? RunStatus.MergeBlocked : RunStatus.Failed,
      integration: run.integration ? { ...run.integration, state: 'blocked', error: message } : undefined,
      leaseToken: null, updatedAt: now, summary: message });
    this.runs.event(id, RunStatus.Failed, message, now);
    this.tasks.addComment({ id: run.taskId, text: `[AUTOMATION FAILED] ${message}`, actor: 'agent' });
    });
  }
  public cancel(id: string): void {
    return this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Run is not active.');
    if (run.status === RunStatus.Integrating && run.integration?.state === 'publishing') throw new TrackerError('CONFLICT', 'Squash publication is already authorized; wait for its result before cancelling.');
    this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(this.clock.now())), budgetUpdatedAt: this.clock.now(),
      status: RunStatus.Cancelled, leaseToken: null, updatedAt: this.clock.now() });
    this.runs.event(id, RunStatus.Cancelled, 'Остановлено пользователем. Worker отменит текущую операцию после проверки lease.', this.clock.now());
    });
  }
  public dequeue(id: string): void {
    return this.runs.db.transaction(() => {
      const run = this.requireRun(id);
      if (run.status !== RunStatus.Queued) throw new TrackerError('CONFLICT', 'Запуск уже покинул очередь. Обновите состояние; выполняющийся запуск можно остановить отдельно.');
      const now = this.clock.now();
      this.runs.save({ ...run, status: RunStatus.Cancelled, leaseToken: null, summary: 'Убрано из очереди. Задача и журнал сохранены.', updatedAt: now });
      this.runs.event(id, RunStatus.Cancelled, 'Убрано из очереди пользователем. Задача и журнал сохранены.', now);
    });
  }
  public resume(id: string): AgentRun {
    return this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    if (!RESUMABLE_RUN_STATUSES.includes(run.status)) throw new TrackerError('CONFLICT', 'Run cannot be resumed.');
    const mergeOnly = run.stage >= run.settings.pipeline.length && run.settings.mergePolicy === MergePolicy.Local;
    const budgetReason = RunBudget.reason(run, Date.parse(this.clock.now()));
    if (budgetReason && !mergeOnly) throw new TrackerError('CONFLICT', `${budgetReason} Start a separate new run explicitly.`);
    if (run.stage >= run.settings.pipeline.length && !mergeOnly) throw new TrackerError('CONFLICT', 'All stages finished; resolve the merge manually.');
    const task = this.tasks.getTaskCard(run.taskId);
    if (task.openQuestionsCount) throw new TrackerError('CONFLICT', 'Answer task questions first.');
    if (task.status === TaskStatus.Done || (task.status === TaskStatus.Review && !mergeOnly)) throw new TrackerError('CONFLICT', 'Task is already complete or in review.');
    if (this.runs.hasActive(run.taskId) && run.status !== RunStatus.Waiting) throw new TrackerError('CONFLICT', 'Task already has another active run.');
    const role = run.settings.agents.find((agent) => agent.id === run.settings.pipeline[run.stage])?.role;
    const stage = run.status === RunStatus.Waiting && role && EVIDENCE_AGENT_ROLES.includes(role)
      ? run.settings.pipeline.findIndex((id) => run.settings.agents.find((agent) => agent.id === id)?.role === AgentRole.Developer) : run.stage;
    const updated: AgentRun = { ...run, stage, status: RunStatus.Queued, leaseToken: null, workerId: null, leaseUntil: null, updatedAt: this.clock.now() };
    this.runs.restore(id);
    this.runs.save(updated);
    this.runs.event(id, 'resumed', 'Продолжение с сохранёнными настройками и checkpoint. Ожидает worker.', this.clock.now());
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
  public merged(id: string, token: string): void {
    return this.runs.db.transaction(() => {
    const run = this.requireRun(id);
    this.owned(id, token);
    if (run.status !== RunStatus.Integrating || run.integration?.state !== 'publishing') throw new TrackerError('CONFLICT', 'Merge publication is not owned by this worker.');
    if (run.mergeReviewRequired) this.tasks.setStatus({ id: run.taskId, status: TaskStatus.Review, actor: 'agent' });
    const evidence = `${run.branch}@${run.commitSha} -> ${run.integration.targetBranch}@${run.integration.candidateSha}`;
    this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(this.clock.now())), budgetUpdatedAt: this.clock.now(),
      summary: `Squash merged: ${evidence}`,
      integration: { ...run.integration, state: 'merged' }, status: RunStatus.Merged, leaseToken: null, updatedAt: this.clock.now() });
    this.runs.event(id, 'merged', evidence, this.clock.now());
    this.tasks.addComment({ id: run.taskId, text: `[AUTOMATION MERGED] ${evidence}. Task remains in review for user acceptance.`, actor: 'agent' });
    });
  }
  private publicRun(run: AgentRun): AgentRun { return { ...run, leaseToken: null }; }
  private expireLeases(): void {
    const now = this.clock.now();
    for (const run of this.runs.running()) {
      if ((run.status === RunStatus.Running || run.status === RunStatus.Integrating) && run.leaseUntil && run.leaseUntil < now) {
        this.runs.save({ ...run, budgetElapsedMs: RunBudget.elapsed(run, Date.parse(run.leaseUntil)), budgetUpdatedAt: now,
          integration: run.integration ? { ...run.integration, state: 'blocked', error: 'Worker lease expired; verify its process before resuming.' } : undefined,
          status: run.status === RunStatus.Integrating ? RunStatus.MergeBlocked : RunStatus.Interrupted, leaseToken: null, updatedAt: now, summary: 'Worker lease expired. Resume explicitly after checking its process.' });
        this.runs.event(run.id, RunStatus.Interrupted, 'Worker lease expired; no automatic duplicate execution.', now);
      }
    }
  }
  private requireRun(id: string): AgentRun {
    const run = this.runs.get(id);
    if (!run) throw new TrackerError('TASK_NOT_FOUND', 'Agent run not found.');
    return run;
  }
}
