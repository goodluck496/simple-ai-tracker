import { setTimeout as delay } from 'node:timers/promises';
import { ProcessExecutor } from '../runners/process-executor.js';
import { TaskEnvironment } from '../runners/task-environment.js';
import type { CheckCommand } from '../../../../shared/automation/contracts.js';

/** A server from the run's worktree, using the already leased PORT. Never attaches to an existing app. */
export class BrowserSession {
  private controller = new AbortController();
  private process?: Promise<unknown>;
  public async start(config: CheckCommand & { readyPath: string }, cwd: string, signal: AbortSignal,
    executor: ProcessExecutor, progress: (text: string) => void): Promise<string> {
    const env = TaskEnvironment.create();
    if (!env.PORT || !/^\d+$/.test(env.PORT)) throw new Error('Browser session requires a leased PORT.');
    const url = `http://127.0.0.1:${env.PORT}${config.readyPath}`;
    const combined = AbortSignal.any([signal, this.controller.signal]);
    let exited = false; let failure: unknown;
    this.process = executor.run({ ...config, args: config.args.map(a => a.replaceAll('{port}', env.PORT!)), cwd, env, signal: combined, compactProgress: true, onProgress: progress })
      .then(() => { exited = true; }, error => { exited = true; failure = error; });
    const started = Date.now();
    while (Date.now() - started < 60000) {
      combined.throwIfAborted();
      if (exited) throw new Error('Browser application exited before readiness: ' + String(failure ?? 'exit 0'));
      try {
        const response = await fetch(url, { signal: AbortSignal.any([combined, AbortSignal.timeout(1000)]), redirect: 'manual' });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) {
          progress(`Browser ready: ${url}; startupMs=${Date.now() - started}\n`);
          return url;
        }
      } catch { combined.throwIfAborted(); }
      await delay(150, undefined, {signal: combined});
    }
    throw new Error('Browser application readiness timed out after 60 seconds.');
  }
  public async close(): Promise<void> { this.controller.abort(); await this.process; }
}
