import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { IntegrationInfo } from '../../../../shared/automation/contracts.js';
import { CommitMessage } from '../../../../shared/automation/commit-message.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { ExecutionScope } from '../runners/execution-scope.js';
import { RuntimeCoordinator } from './runtime-coordinator.js';
import { RunWorkspace } from './run-workspace.js';

export interface IntegrationJob {
  runId: string; taskId: string; repository: string; common: string; sourceSha: string;
  targetBranch: string; directory: string; message: string; contextKey: string; maxAttempts: number;
  signal: AbortSignal;
  recoveryOnly?: boolean;
  prepare(cwd: string): Promise<void>;
  checks(cwd: string): Promise<void>;
  resolve(cwd: string, files: string[], baseSha: string): Promise<void>;
  authorize(): Promise<void>;
  record(info: IntegrationInfo): Promise<void>;
}
interface Receipt extends IntegrationInfo { contextKey: string; checked: boolean; squashed: boolean; }

/** One host-local merge queue; candidates live in separate worktrees, never the user's checkout. */
export class SquashIntegration {
  public constructor(private readonly executor = new ProcessExecutor()) {}
  public async run(job: IntegrationJob): Promise<IntegrationInfo> {
    const coordinator = new RuntimeCoordinator(path.join(job.common, 'sat-runtime', 'coordination.sqlite'));
    const lock = await coordinator.acquire('merge', job.signal);
    const scope = ExecutionScope.current;
    try {
      return await ExecutionScope.run({ ...scope, child: (pid, active) => { scope?.child?.(pid, active); lock.child(pid, active); } }, () => this.integrate(job));
    } finally { lock.release(); coordinator.close(); }
  }
  private async integrate(job: IntegrationJob): Promise<IntegrationInfo> {
    await RunWorkspace.ignoreRuntime(job.common);
    const git = (args: string[], cwd = job.repository) => this.executor.run({ command: 'git', args, cwd, signal: job.signal });
    const head = () => git(['rev-parse', '--verify', `refs/heads/${job.targetBranch}^{commit}`]).then(s => s.trim());
    const receiptFile = path.join(job.common, 'sat-runtime', 'integrations', `${job.runId}.json`);
    const sourceFile = path.join(job.common, 'sat-runtime', 'integrations', 'by-source', createHash('sha256').update(`${job.targetBranch}\0${job.sourceSha}`).digest('hex') + '.json');
    let receipt: Receipt | undefined;
    try { receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as Receipt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const write = async (value: Receipt) => {
      receipt = value; await RunWorkspace.atomic(receiptFile, value);
      if (value.checked && !value.noChanges) await RunWorkspace.atomic(sourceFile, value);
      await job.record(value);
    };
    const ancestor = async (sha: string, target: string) => {
      try { await git(['merge-base', '--is-ancestor', sha, target]); return true; }
      catch (error) { if (String(error).includes('failed (1)')) return false; throw error; }
    };
    let previous: Receipt | undefined;
    try { previous = JSON.parse(await fs.readFile(sourceFile, 'utf8')) as Receipt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous?.checked && previous.candidateSha && await ancestor(previous.candidateSha, await head())) {
      if (previous.contextKey !== job.contextKey) throw new Error('This source was already published under different requirements; inspect the task rather than applying it twice.');
      await job.authorize(); await write({ ...previous, attempt: receipt?.attempt ?? 1, state: 'publishing' }); return receipt!;
    }
    if (receipt && (receipt.sourceSha !== job.sourceSha || receipt.contextKey !== job.contextKey || receipt.targetBranch !== job.targetBranch))
      throw new Error('Integration receipt belongs to different source/requirements; preserve it and inspect the run.');
    if (receipt?.checked && receipt.candidateSha && await ancestor(receipt.candidateSha, await head())) {
      // Crash after Git publication but before tracker acknowledgement: do not squash twice.
      await job.authorize(); await write({ ...receipt, state: 'publishing' }); return receipt;
    }
    if (job.recoveryOnly) throw new Error('Budget exhausted: no published receipt can be acknowledged without executing more work. Restart integration explicitly for a new budget.');
    for (let attempt = receipt?.attempt ?? 1; attempt <= job.maxAttempts; attempt++) {
      job.signal.throwIfAborted(); await job.authorize();
      const base = await head();
      if ((await git(['branch', '--show-current'])).trim() !== job.targetBranch || (await git(['status', '--porcelain'])).trim())
        throw new Error('Target checkout must be clean and on the configured integration branch.');
      if (receipt && receipt.baseSha !== base) { attempt = Math.max(attempt, receipt.attempt + 1); receipt = undefined; }
      if (attempt > job.maxAttempts) throw new Error('Target branch moved; integration retry budget exhausted.');
      const cwd = `${job.directory}-integration-${attempt}`;
      const branch = `sat-integration/${job.runId}-${attempt}`;
      if (!receipt) {
        try { await fs.access(cwd); throw new Error('Uncheckpointed integration worktree exists; inspect it before resuming.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await fs.mkdir(path.dirname(cwd), { recursive: true });
        await git(['worktree', 'add', '-b', branch, cwd, base]);
        await write({ state: 'preparing', sourceSha: job.sourceSha, baseSha: base, targetBranch: job.targetBranch,
          worktreePath: cwd, attempt, contextKey: job.contextKey, checked: false, squashed: false });
      }
      if (receipt!.worktreePath !== cwd || (await git(['branch', '--show-current'], cwd)).trim() !== branch)
        throw new Error('Integration worktree identity changed.');
      if (receipt!.candidateSha) {
        if ((await git(['rev-parse', 'HEAD'], cwd)).trim() !== receipt!.candidateSha || (await git(['status', '--porcelain'], cwd)).trim())
          throw new Error('Integration candidate changed after checkpoint; preserve and inspect its files.');
      } else {
        if (!receipt!.squashed) {
          if ((await git(['status', '--porcelain'], cwd)).trim()) throw new Error('Merge interrupted before checkpoint; inspect the preserved integration worktree.');
          let mergeError: unknown;
          try { await git(['merge', '--squash', '--no-commit', job.sourceSha], cwd); } catch (error) { mergeError = error; }
          const unmerged = await git(['diff', '--name-only', '--diff-filter=U', '-z'], cwd);
          if (mergeError && !unmerged) throw mergeError;
          await write({ ...receipt!, squashed: true, state: unmerged ? 'resolving' : 'preparing' });
        }
        const conflicts = (await git(['diff', '--name-only', '--diff-filter=U', '-z'], cwd)).split('\0').filter(Boolean);
        if (conflicts.length) {
          const outsideIndex = async () => (await git(['ls-files', '--stage', '-z'], cwd)).split('\0')
            .filter(record => !conflicts.includes(record.slice(record.indexOf('\t') + 1))).sort().join('\0');
          const before = await outsideIndex();
          await write({ ...receipt!, state: 'resolving' });
          await job.resolve(cwd, conflicts, base);
          if ((await git(['rev-parse', 'HEAD'], cwd)).trim() !== base || (await git(['branch', '--show-current'], cwd)).trim() !== branch)
            throw new Error('Resolver changed Git HEAD/branch.');
          const unstaged = (await git(['diff', '--name-only', '-z'], cwd)).split('\0').filter(Boolean);
          if (unstaged.some(file => !conflicts.includes(file)) || before !== await outsideIndex()
            || (await git(['ls-files', '--others', '--exclude-standard'], cwd)).trim()) throw new Error('Resolver changed files outside the conflict set.');
          await git(['add', '--', ...conflicts.map(file => `:(literal)${file}`)], cwd);
          await git(['diff', '--cached', '--check', '--', ...conflicts.map(file => `:(literal)${file}`)], cwd);
        }
        if ((await git(['ls-files', '--unmerged'], cwd)).trim()) throw new Error('Unresolved merge entries remain.');
        const changed = (await git(['diff', '--cached', '--name-only'], cwd)).trim();
        if (changed) {
          const message = CommitMessage.validate(job.message, job.taskId);
          await git(['commit', '-m', message], cwd);
          if ((await git(['log', '-1', '--format=%s'], cwd)).trim() !== message) throw new Error('Git hook changed the validated squash subject.');
        }
        await write({ ...receipt!, state: 'checking', candidateSha: (await git(['rev-parse', 'HEAD'], cwd)).trim(), noChanges: !changed });
      }
      if (!receipt!.checked) {
        await job.prepare(cwd);
        await job.checks(cwd);
        if ((await git(['rev-parse', 'HEAD'], cwd)).trim() !== receipt!.candidateSha || (await git(['status', '--porcelain'], cwd)).trim())
          throw new Error('Integration checks changed the tested tree.');
        await write({ ...receipt!, state: 'ready', checked: true });
      }
      await job.authorize();
      if (await head() !== base) { receipt = { ...receipt!, state: 'ready' }; continue; }
      if ((await git(['branch', '--show-current'])).trim() !== job.targetBranch || (await git(['status', '--porcelain'])).trim())
        throw new Error('Target checkout changed during integration checks.');
      // Publication is fenced in tracker: cancel cannot interleave this short critical section.
      await write({ ...receipt!, state: 'publishing' });
      await job.authorize();
      if (await head() !== base) throw new Error('Target HEAD changed before publication; resume integration against the new base.');
      // Once authorized, let Git finish its checkout/ref transaction instead of killing it mid-publication.
      // There are no model calls here; the bounded critical section has its own shutdown deadline.
      await this.executor.run({ command: 'git', args: ['merge', '--ff-only', '--no-overwrite-ignore', receipt!.candidateSha!],
        cwd: job.repository, signal: AbortSignal.timeout(120000) });
      return receipt!;
    }
    throw new Error('Integration retry budget exhausted.');
  }
}
