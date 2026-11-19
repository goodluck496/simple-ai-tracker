import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRun, CheckCommand } from '../../../../shared/automation/contracts.js';
import type { BrowserCheckResult, CheckExecution, CheckOutcome } from '../../../../shared/automation/improvement-metrics.js';
import { checkBelongsToRun, checkFingerprint, checksMatch } from '../check-evidence.js';
import { ProcessExecutionError, ProcessLaunchError } from '../runners/process-executor.js';

/** Persist subprocess results before calling the server and replay by identity after a transport failure. */
export class CheckJournal {
  public constructor(private readonly root: string, private readonly deliver: (result: CheckExecution) => Promise<void>,
    private readonly begin?: (intent: CheckExecution) => Promise<void>) {}

  public async run(
    run: AgentRun, phase: CheckExecution['phase'], sha: string, attempt: number, signal: AbortSignal,
    execute: (check: CheckCommand) => Promise<BrowserCheckResult[] | void>,
    before?: (check: CheckCommand) => Promise<void>,
  ): Promise<CheckExecution[]> {
    const context = { runId: run.id, phase, revision: run.revision, sha };
    const previous = (await this.read()).filter(check => checkBelongsToRun(check, run)
      && check.phase === phase && check.sha === sha && check.attempt === attempt);
    for (const result of previous) await this.deliver(result);
    const successes = previous.filter(result => result.outcome.kind === 'exit' && result.outcome.code === 0)
      .sort((a, b) => a.position - b.position);
    if (checksMatch(successes, run.settings.checks, context)) return successes;

    const results: CheckExecution[] = [];
    for (const [position, check] of run.settings.checks.entries()) {
      signal.throwIfAborted();
      const reused = successes.find(result => result.position === position);
      if (reused) { results.push(reused); continue; }
      await before?.(check);
      signal.throwIfAborted();
      const intent: CheckExecution = { ...context, id: randomUUID(), stage: run.stage, attempt,
        fingerprint: checkFingerprint(run.settings.checks), position, ...check, outcome: { kind: 'unknown' }, at: new Date().toISOString() };
      await this.begin?.(intent);
      signal.throwIfAborted();
      let outcome: CheckOutcome = { kind: 'exit', code: 0 };
      let failure: unknown;
      let browserResults: BrowserCheckResult[] | void = undefined;
      try { browserResults = await execute(check); } catch (error) {
        failure = error;
        outcome = signal.aborted ? { kind: 'unknown' }
          : error instanceof ProcessExecutionError && error.exitCode !== null ? { kind: 'exit', code: error.exitCode }
          : error instanceof ProcessLaunchError ? { kind: 'launch_error' } : { kind: 'unknown' };
      }
      const result: CheckExecution = { ...intent, outcome, at: new Date().toISOString(),
        browserResults: browserResults || undefined };
      await fs.mkdir(this.root, { recursive: true });
      const file = path.join(this.root, result.id + '.json');
      await fs.writeFile(file + '.tmp', JSON.stringify(result), 'utf8');
      await fs.rename(file + '.tmp', file);
      await this.deliver(result);
      if (outcome.kind !== 'exit' || outcome.code !== 0) throw failure;
      results.push(result);
    }
    return results;
  }

  public async verify(run: AgentRun, sha: string, attempt: number, ids: string[]): Promise<boolean> {
    const available = new Map((await this.read()).map(check => [check.id, check]));
    const results = ids.map(id => available.get(id)).filter((check): check is CheckExecution => !!check);
    if (ids.length !== results.length || results.some(check => check.attempt !== attempt || !checkBelongsToRun(check, run))
      || !checksMatch(results, run.settings.checks, { runId: run.id, phase: 'candidate', revision: run.revision, sha })) return false;
    for (const result of results) await this.deliver(result);
    return true;
  }

  private async read(): Promise<CheckExecution[]> {
    const files = await fs.readdir(this.root).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [] as string[];
    });
    return Promise.all(files.filter(file => /^[\da-f-]{36}\.json$/.test(file))
      .map(async file => JSON.parse(await fs.readFile(path.join(this.root, file), 'utf8')) as CheckExecution));
  }
}
