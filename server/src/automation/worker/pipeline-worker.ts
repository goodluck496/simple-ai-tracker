import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentRole, RunStatus, AgentVerdict, MergePolicy, READ_ONLY_AGENT_ROLES, AGENT_VERDICTS, AUTOMATION_TIMING, AUTOMATION_LIMITS, type AgentOutcome, type AgentRun } from '../../../../shared/automation/contracts.js';
import type { TrackerChannel } from './mcp-client.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import { AutomationTool } from '../../../../shared/automation/protocol.js';
import { DEFAULT_ROLE_INSTRUCTIONS } from '../../../../shared/automation/team-profiles.js';
import { RunPhase } from '../../../../shared/automation/queue.js';
import type { TokenUsage } from '../../../../shared/automation/token-usage.js';
import { WorktreePreparation } from './worktree-preparation.js';
import { StageCheckpoint, type StageResult } from './stage-checkpoint.js';
import { AgentHandoff } from '../../../../shared/automation/handoff.js';
import { ProgressBuffer } from '../../../../shared/automation/progress-buffer.js';
import { RunBudget } from '../../../../shared/automation/budget.js';
import { TaskEnvironment } from '../runners/task-environment.js';
import { CommitMessage } from '../../../../shared/automation/commit-message.js';
import { RuntimeCoordinator, type RuntimeLease } from './runtime-coordinator.js';
import { RunWorkspace } from './run-workspace.js';
import { ExecutionScope } from '../runners/execution-scope.js';
import { SquashIntegration } from './squash-integration.js';
import { MergeResolver } from './merge-resolver.js';
import { TaskRuntime } from './task-runtime.js';

export class PipelineWorker {
  private activeController?: AbortController;
  public constructor(private readonly channel: TrackerChannel, private readonly workerId: string,
    private readonly executor = new ProcessExecutor(), private readonly registry = new AgentRunnerRegistry()) {}
  public stop(): void { this.activeController?.abort(); }

  public async tick(): Promise<boolean> {
    const claimed = await this.channel.call<AgentRun | null>(AutomationTool.Claim, { workerId: this.workerId });
    if (!claimed) return false;
    let run: AgentRun = claimed;
    const token = run.leaseToken!;
    const controller = new AbortController();
    this.activeController = controller;
    let finished = false;
    let publishing = false;
    let coordinator: RuntimeCoordinator | undefined;
    const leases: RuntimeLease[] = [];
    let runtime: TaskRuntime | undefined;
    let budgetError: string | undefined;
    const remainingMs = RunBudget.limits(run).minutes * 60000 - RunBudget.elapsed(run, Date.now());
    const timeout = setTimeout(() => { budgetError = 'Run stopped: execution time budget exhausted.'; controller.abort(); },
      Math.max(0, Math.min(run.settings.timeoutMinutes * 60_000, remainingMs)));
    const pending = new ProgressBuffer(); let channelError: unknown;
    let heartbeatBusy = false;
    let metering: { attemptId: string; usage?: TokenUsage } | undefined;
    const reportUsage = async (sample: { attemptId: string; usage?: TokenUsage }, finished = false) => {
      await this.channel.call(AutomationTool.Usage, { id: run!.id, leaseToken: token, ...sample, finished });
    };
    const redact = (value: string): string => {
      for (const connection of run!.settings.connections) {
        const secret = connection.credentialEnv ? process.env[connection.credentialEnv] : undefined;
        if (secret) value = value.split(secret).join('[REDACTED]');
      }
      return value;
    };
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || publishing) return;
      heartbeatBusy = true;
      void (async () => {
        await this.channel.call(AutomationTool.Heartbeat, { id: run!.id, leaseToken: token });
        if (metering?.usage) await reportUsage({ ...metering });
        if (pending.length) {
          const text = redact(pending.take());
          await this.channel.call(AutomationTool.Progress, { id: run!.id, leaseToken: token, text });
        }
      })().catch((error: unknown) => { if (!finished) { channelError = error; controller.abort(); } }).finally(() => { heartbeatBusy = false; });
    }, AUTOMATION_TIMING.heartbeatMs);
    const progress = (text: string) => { pending.append(text); };
    const phase = async (value: RunPhase, text: string) => { await this.channel.call(AutomationTool.Progress, { id: run!.id, leaseToken: token, phase: value, text }); };
    try {
      await phase(RunPhase.Preparing, 'Создание или проверка отдельной рабочей ветки.');
      if (!path.isAbsolute(run.settings.repositoryPath)) throw new Error('Repository path must be absolute on the worker host.');
      const location = await RunWorkspace.describe(run.settings.repositoryPath, run.id, process.env.SAT_WORKSPACE ?? 'default', this.executor, controller.signal);
      const { root: repository, common, directory: cwd, branch, git } = location;
      coordinator = new RuntimeCoordinator(path.join(common, 'sat-runtime', 'coordination.sqlite'));
      leases.push(await coordinator.acquire(`run:${run.id}`, controller.signal));
      await phase(RunPhase.Preparing, 'Ожидание свободного слота проекта.');
      leases.push(await coordinator.acquire(`slot:${run.id}`, controller.signal, run.settings.maxParallelRuns ?? 2));
      const execution = { env: undefined as NodeJS.ProcessEnv | undefined,
        child: (pid: number, active: boolean) => { for (const lease of leases) lease.child(pid, active); runtime?.child(pid, active); } };
      await ExecutionScope.run(execution, async () => {
      let newCheckout = false;
      try { await fs.access(cwd); }
      catch {
        if ((await git(['status', '--porcelain'])).trim()) throw new Error('Repository has local changes; commit or preserve them before starting a new task.');
        if (run!.settings.mergePolicy === MergePolicy.Local && (await git(['branch', '--show-current'])).trim() !== run!.settings.baseBranch)
          throw new Error('Target branch must be checked out before automatic integration.');
        await fs.mkdir(path.dirname(cwd), { recursive: true });
        await git(['worktree', 'add', '-b', branch, cwd, run!.settings.baseBranch]);
        newCheckout = true;
      }
      if ((await git(['branch', '--show-current'], cwd)).trim() !== branch) throw new Error('Worktree branch does not match run.');
      await RunWorkspace.ignoreRuntime(common);
      runtime = await TaskRuntime.create(cwd, controller.signal); execution.env = runtime.env;
      const descriptor = path.join(cwd, '.sat', 'checkout.json');
      let baseSha: string;
      try { baseSha = JSON.parse(await fs.readFile(descriptor, 'utf8')).baseSha as string; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        baseSha = run!.checkout?.baseSha ?? (await git(newCheckout ? ['rev-parse', 'HEAD'] : ['merge-base', 'HEAD', run!.settings.baseBranch], cwd)).trim();
        await RunWorkspace.atomic(descriptor, { baseSha, repository, runId: run!.id });
      }
      await this.channel.call(AutomationTool.Checkout, { id: run!.id, leaseToken: token,
        result: { repositoryRoot: repository, worktreePath: cwd, baseSha, dependencyMode: 'isolated' } });
      await phase(RunPhase.Setup, 'Проверка и подготовка зависимостей worktree до запуска агента.');
      await new WorktreePreparation(this.executor).prepare(cwd, run.settings.setup, controller.signal, progress);
      while (run.status === RunStatus.Running && run.stage < run.settings.pipeline.length) {
        controller.signal.throwIfAborted();
        const profileId = run.settings.pipeline[run.stage];
        const profile = run.settings.agents.find((agent) => agent.id === profileId)!;
        const connection = run.settings.connections.find((entry) => entry.id === profile.connectionId)!;
        if (profile.role === AgentRole.VisualValidator) {
          const images = run.settings.artifactPaths.filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
          if (!images.length) throw new Error('Visual validator requires configured image artifacts.');
          for (const file of images) await fs.access(path.join(cwd, file));
        }
        const pack = await this.channel.call<Record<string, unknown>>('tracker_get_task', { id: run.taskId, commentsLimit: 5 });
        const context = { id: pack.id, title: pack.title, description: pack.description, plan: pack.plan, questions: pack.questions, relations: pack.relations, comments: pack.comments };
        // Failure comments and run.summary change on infrastructure failure, so they are not cache keys.
        const checkpoint = new StageCheckpoint(cwd, run.stage, run.revision, (args) => git(args, cwd));
        const key = StageCheckpoint.key({ id: run.id, stage: run.stage, revision: run.revision, settings: run.settings,
          task: { id: pack.id, title: pack.title, description: pack.description, plan: pack.plan, questions: pack.questions, relations: pack.relations } });
        let saved = await checkpoint.load(key);
        const priorSha = (await git(['rev-parse', 'HEAD'], cwd)).trim();
        if (run.commitSha && priorSha !== run.commitSha && !saved) throw new Error('Worktree HEAD changed after checkpoint; inspect it before resuming.');
        const priorStatus = await git(['status', '--porcelain', '--', '.', ':!.sat'], cwd);
        const diff = await git(['diff', `${run.settings.baseBranch}...HEAD`, '--', '.', ':!.sat'], cwd);
        const prompt = this.prompt(profile.role, profile.instructions, context, run.summary, diff.slice(-60000), run.settings.artifactPaths, run.settings.checks);
        let outcome: AgentOutcome;
        if (saved) {
          outcome = this.parseOutcome(JSON.stringify(saved.outcome));
          await phase(RunPhase.Preparing, 'Результат агента восстановлен из checkpoint; повторный вызов модели не нужен.');
        } else {
        const reason = RunBudget.reason(run, Date.now(), true);
        if (reason) throw new Error(reason);
        const started = await this.channel.call<{ attemptId?: string }>(AutomationTool.BeginStage, { id: run.id, leaseToken: token });
        metering = started.attemptId ? { attemptId: started.attemptId } : undefined;
        let usageComplete = false;
        try {
          const result = await this.registry.get(profile.runner).run({ runId: run.id, cwd, prompt, profile, connection, settings: run.settings, signal: controller.signal,
            onUsage: (usage) => {
              if (metering) {
                metering = { ...metering, usage };
                const previous = (run!.usageAttempts ?? []).filter(a => a.id !== metering!.attemptId);
                const total = previous.reduce((sum, a) => sum + (a.usage?.inputTokens ?? 0), 0) + usage.inputTokens;
                if (total >= RunBudget.limits(run!).input) {
                  budgetError = `Run stopped: input token budget exhausted (${total}; cached included).`;
                  controller.abort();
                }
              }
            } }, progress);
          if (result.usage && metering) metering = { ...metering, usage: result.usage };
          usageComplete = true;
          outcome = this.parseOutcome(result.text);
          outcome.summary = redact(outcome.summary);
          if (typeof outcome.commitMessage === 'string') outcome.commitMessage = redact(outcome.commitMessage);
          if (outcome.plan) outcome.plan = redact(outcome.plan);
          if (outcome.questions) outcome.questions = outcome.questions.map(redact);
        } catch (error) {
          throw new Error(`${profile.role}/${profile.runner}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (metering) {
            const sample = metering; metering = undefined;
            await reportUsage(sample, usageComplete);
          }
        }
        saved = { key, head: priorSha, fingerprint: '', priorHead: priorSha, priorStatus, outcome };
        if (outcome.verdict === AgentVerdict.Pass) await checkpoint.save(saved);
        }
        if (READ_ONLY_AGENT_ROLES.includes(profile.role)) {
          if ((await git(['rev-parse', 'HEAD'], cwd)).trim() !== saved.priorHead || (await git(['status', '--porcelain', '--', '.', ':!.sat'], cwd)) !== saved.priorStatus) throw new Error('Read-only stage modified the worktree or HEAD.');
        } else if (outcome.verdict === AgentVerdict.Pass) {
          // Runtime is ignored through info/exclude. An explicit ignored .sat pathspec can make git add fail.
          await git(['add', '-A', '--', '.'], cwd);
          await checkpoint.save(saved);
          if ((await git(['diff', '--cached', '--name-only'], cwd)).trim()) {
            const message = CommitMessage.validate(outcome.commitMessage, run.taskId);
            await git(['commit', '-m', message], cwd);
          }
          await checkpoint.save(saved);
        }
        let sha = (await git(['rev-parse', 'HEAD'], cwd)).trim();
        if (profile.role === AgentRole.Tester && outcome.verdict === AgentVerdict.Pass && !saved.checksComplete) {
          for (const check of run.settings.checks) {
            try {
              await phase(RunPhase.Checks, `Проверка: ${check.command} ${check.args.join(' ')}`);
              await this.executor.run({ ...check, cwd, env: TaskEnvironment.create(), signal: controller.signal, onProgress: progress });
            }
            catch (error) { outcome = { verdict: AgentVerdict.ChangesRequested, summary: redact(`Configured check failed: ${error instanceof Error ? error.message : String(error)}`) }; break; }
          }
          if ((await git(['rev-parse', 'HEAD'], cwd)).trim() !== sha || (await git(['status', '--porcelain', '--', '.', ':!.sat'], cwd)).trim()) throw new Error('Checks changed the tested commit or left uncommitted files.');
          saved.outcome = outcome;
          saved.checksComplete = outcome.verdict === AgentVerdict.Pass;
          if (saved.checksComplete) await checkpoint.save(saved);
        }
        if (pending.length) { await this.channel.call(AutomationTool.Progress, { id: run.id, leaseToken: token, text: redact(pending.take()) }); }
        run = await this.channel.call<AgentRun>(AutomationTool.CompleteStage, { id: run.id, leaseToken: token, outcome, branch, commitSha: sha });
      }
      if (run!.status === RunStatus.Integrating) {
        if ((await git(['rev-parse', 'HEAD'], cwd)).trim() !== run!.commitSha) throw new Error('Source branch changed after review.');
        const pack = await this.channel.call<Record<string, unknown>>('tracker_get_task', { id: run!.taskId, commentsLimit: 0 });
        const context = { id: pack.id, title: pack.title, description: pack.description, plan: pack.plan, questions: pack.questions, relations: pack.relations, comments: [] };
        const resolver = new MergeResolver(this.executor, async (profile, prompt, directory, signal, maxTools) => {
          const started = await this.channel.call<{ attemptId: string }>(AutomationTool.BeginStage, { id: run!.id, leaseToken: token, phase: 'resolver' });
          metering = { attemptId: started.attemptId };
          let complete = false;
          try {
            const connection = run!.settings.connections.find(c => c.id === profile.connectionId)!;
            const result = await this.registry.get(profile.runner).run({ runId: run!.id, cwd: directory, profile, connection,
              prompt, settings: run!.settings, signal, maxToolCalls: maxTools,
              onUsage: usage => { if (metering) metering = { ...metering, usage }; } }, progress);
            if (result.usage && metering) metering = { ...metering, usage: result.usage };
            const outcome = this.parseOutcome(result.text); outcome.summary = redact(outcome.summary);
            if (outcome.verdict === AgentVerdict.Questions && outcome.questions?.length) await this.channel.call('tracker_ask_questions', { id: run!.taskId, questions: outcome.questions, phase: 'testing' });
            complete = true; return outcome;
          } finally { if (metering) { const sample = metering; metering = undefined; await reportUsage(sample, complete); } }
        });
        await new SquashIntegration(this.executor).run({ runId: run!.id, taskId: run!.taskId, repository, common,
          sourceSha: run!.commitSha!, targetBranch: run!.settings.baseBranch, directory: cwd,
          message: run!.mergeMessage ?? '', contextKey: StageCheckpoint.key(context), maxAttempts: run!.settings.maxMergeAttempts ?? 2,
          signal: controller.signal,
          authorize: async () => { run = await this.channel.call<AgentRun>(AutomationTool.Heartbeat, { id: run!.id, leaseToken: token }); },
          record: async info => { publishing = info.state === 'publishing'; await this.channel.call(AutomationTool.Integration, { id: run!.id, leaseToken: token, result: info }); },
          prepare: directory => new WorktreePreparation(this.executor).prepare(directory, run!.settings.setup, controller.signal, progress),
          checks: async directory => { for (const check of run!.settings.checks) await this.executor.run({ ...check, cwd: directory,
            env: TaskEnvironment.create(), signal: controller.signal, onProgress: progress }); },
          resolve: (directory, files, base) => resolver.resolve(run!, context, directory, files, base, controller.signal),
        });
        await this.channel.call(AutomationTool.Merged, { id: run!.id, leaseToken: token });
      }
      });
      finished = true;
    } catch (error) {
      const message = redact(budgetError ?? `${channelError ? 'Tracker connection/lease lost. ' : ''}${error instanceof Error ? error.message : String(error)}`);
      if (pending.length) { try { await this.channel.call(AutomationTool.Progress, { id: run.id, leaseToken: token, text: redact(pending.take()) }); } catch { /* Preserve terminal failure even if the lease was lost. */ } }
      try { await this.channel.call(AutomationTool.Fail, { id: run.id, leaseToken: token, text: message }); }
      catch { process.stderr.write(`${message}\n`); }
    } finally {
      finished = true;
      this.activeController = undefined;
      clearTimeout(timeout); clearInterval(heartbeat);
      for (const lease of leases.reverse()) lease.release();
      runtime?.close();
      coordinator?.close();
    }
    return true;
  }

  public parseOutcome(text: string): AgentOutcome {
    const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const result = JSON.parse(clean) as AgentOutcome;
    if (!AGENT_VERDICTS.includes(result.verdict) || typeof result.summary !== 'string') throw new Error('Agent must return a valid JSON verdict.');
    return result;
  }
  private prompt(role: AgentRole, instructions: string, context: unknown, feedback: string, diff: string, artifacts: string[], checks: unknown): string {
    const roleInstructions: Record<AgentRole, string> = {
      [AgentRole.Analyst]: 'Produce an implementation plan for the requested change. Missing implementation and failing pre-change checks are expected, not review findings. If requirements are clear, return pass with a nonempty markdown plan. Otherwise return questions. Never return changes_requested.',
      [AgentRole.Developer]: 'Implement the accepted plan by editing project files. Include the necessary tests. Return pass only after implementing the requested behavior.',
      [AgentRole.Designer]: 'Implement the requested visual design in project files, following the accepted plan and supplied references.',
      [AgentRole.Tester]: 'Assess the implemented behavior and test coverage. Use the configured checks when helpful. Return changes_requested for defects or missing coverage. Do not edit files.',
      [AgentRole.Reviewer]: 'Independently inspect the current diff against the requirements and accepted plan. Report concrete defects with changes_requested, otherwise pass. Do not edit files.',
      [AgentRole.VisualValidator]: 'Inspect the actual supplied images against the visual requirements. State the affected area and severity for each issue. Do not infer working behavior from appearance alone. Do not edit files.',
    };
    return `You are the ${role}. ${instructions.trim() || DEFAULT_ROLE_INSTRUCTIONS[role]}\nRead repository AGENTS.md and applicable instructions before work.\n`
      + `${roleInstructions[role]}\n`
      + `Tracker workspace: ${process.env.SAT_WORKSPACE ?? 'default'}. The worker supplies the current task context via MCP. If you consult tracker tools, always pass this explicit workspace. Do not change tracker data yourself.\n`
      + `${AgentHandoff.instructions}\nTask context:\n${AgentHandoff.task(context)}\nPrevious feedback:\n${AgentHandoff.feedback(feedback)}\nChanges:\n${AgentHandoff.diff(diff)}\n`
      + `Configured checks: ${JSON.stringify(checks)}\nVisual artifacts: ${JSON.stringify(artifacts)}\n`
      + `Only developer/designer may edit files. Do not change branches, commit, merge, publish or alter tracker data directly; the worker handles commits. `
      + `When developer/designer changes files, include commitMessage in the JSON result. Exact format: "[#${(context as { id: string }).id}] - описание на русском, что сделано и для чего". Use an explicit purpose clause (для/чтобы/ради), one line, up to ${CommitMessage.maxLength} characters. Technical names may stay in English. A generic role/stage label is forbidden. Worker rejects invalid messages without recalling the model. `
      + `The worker prepared dependencies before this invocation. Reuse that environment; only change/install dependencies when required by the task's manifest changes. Do not repeatedly reinstall packages for an unchanged infrastructure failure. `
      + `For visual validation inspect the actual artifacts; if absent return questions. `
      + `Return ONLY one JSON object, for example {"verdict":"pass","summary":"evidence and findings","questions":[],"plan":"markdown plan for analyst"}. Allowed verdicts are pass, changes_requested, questions, blocked. Return blocked for unavailable tools, permissions, infrastructure or environment failures; do not request code revisions to bypass them. `
      + `Analyst must include plan on pass. Do not claim checks passed without evidence. Never mark a task done.`;
  }
}
