import type { AgentOutcome, AgentProfile, AgentRun } from '../../../../shared/automation/contracts.js';
import { AgentHandoff } from '../../../../shared/automation/handoff.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { StageCheckpoint } from './stage-checkpoint.js';

type Invoke = (profile: AgentProfile, prompt: string, cwd: string, signal: AbortSignal, maxTools: number | undefined) => Promise<AgentOutcome>;

/** Bounded conflict-only model operation; successful output is checkpointed before Git staging. */
export class MergeResolver {
  public constructor(private readonly executor: ProcessExecutor, private readonly invoke: Invoke) {}
  public async resolve(run: AgentRun, context: unknown, cwd: string, files: string[], baseSha: string, signal: AbortSignal): Promise<void> {
    if (run.settings.resolveConflicts === false) throw new Error('Automatic conflict resolution is disabled.');
    if (files.length > 10) throw new Error('Too many conflict files for automatic resolution; inspect the preserved integration worktree.');
    const profile = run.settings.agents.find(agent => agent.role === 'developer')!;
    if (!['codex', 'model-api', 'custom'].includes(profile.runner)) throw new Error('This native runner does not expose bounded resolver steps; resolve manually or select Codex/model-api.');
    const resolverSignal = run.trustedExecution ? signal : AbortSignal.any([signal, AbortSignal.timeout((run.settings.resolverTimeoutMinutes ?? 3) * 60000)]);
    const git = (args: string[]) => this.executor.run({ command: 'git', args, cwd, signal: resolverSignal, maxOutputChars: 50000 });
    const checkpoint = new StageCheckpoint(cwd, run.settings.pipeline.length, run.revision, git);
    const key = StageCheckpoint.key({ run: run.id, source: run.commitSha, baseSha, context, files });
    if (await checkpoint.load(key)) return;
    const stages = (await git(['ls-files', '--unmerged', '-z'])).split('\0');
    const descriptions: unknown[] = [];
    let size = 0;
    for (const file of files) {
      const parts: Record<string, string> = {};
      for (const stage of [1, 2, 3]) {
        if (!stages.some(record => record.slice(0, record.indexOf('\t')).endsWith(` ${stage}`) && record.slice(record.indexOf('\t') + 1) === file)) {
          parts[String(stage)] = '(absent)'; continue;
        }
        const content = await git(['show', `:${stage}:${file}`]);
        if (content.includes('\0') || content.includes('\uFFFD') || content.length > 8000) throw new Error('Binary or oversized conflict requires manual review.');
        size += content.length;
        if (size > 24000) throw new Error('Conflict context exceeds resolver limit; no partial conflict instructions were sent.');
        parts[String(stage)] = content;
      }
      descriptions.push({ file, base_1: parts['1'], target_2: parts['2'], task_3: parts['3'] });
    }
    const prompt = `Resolve only these conflicted files in this integration worktree. Preserve both task requirements and current target behavior. Never choose ours/theirs mechanically. Do not edit other files, stage, commit, change branches, install packages, push, or access live data. Do not create acceptance.log, reports, or any other new file outside .sat. The worker runs checks after resolution: do not redirect command output into project files. If intent is ambiguous return blocked or questions. Return JSON {"verdict":"pass|blocked|questions","summary":"brief evidence","questions":[],"plan":"","commitMessage":""}.\n`
      + `${AgentHandoff.instructions}\nTask context:\n${AgentHandoff.task(context)}\nConflicts (base/target/task):\n${JSON.stringify(descriptions)}`;
    const priorHead = (await git(['rev-parse', 'HEAD'])).trim();
    const priorStatus = await git(['status', '--porcelain']);
    const outcome = await this.invoke(profile, prompt, cwd, resolverSignal, run.trustedExecution ? undefined : run.settings.maxResolverToolCalls ?? 16);
    if (outcome.verdict !== 'pass') throw new Error(`Conflict resolver blocked: ${outcome.summary}`);
    await checkpoint.save({ key, head: priorHead, fingerprint: '', priorHead, priorStatus, outcome });
  }
}
