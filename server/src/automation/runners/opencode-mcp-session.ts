import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentJob } from '../../../../shared/automation/contracts.js';
import type { ProcessExecutor } from './process-executor.js';
import { TaskEnvironment } from './task-environment.js';

/** OpenCode 2 registers MCP asynchronously on cold locations. Wait before asking its model. */
export async function openOpenCodeMcpSession(
  job: AgentJob, names: string[], executor: Pick<ProcessExecutor, 'run'>,
): Promise<{ url: string; env: NodeJS.ProcessEnv; close(): Promise<void> }> {
  const stop = new AbortController();
  const signal = AbortSignal.any([job.signal, stop.signal]);
  const readySignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const password = randomUUID();
  const env = { ...TaskEnvironment.create(), OPENCODE_PASSWORD: password };
  let url: string | undefined;
  let output = '';
  let exited = false;
  const processExit = executor.run({
    command: 'opencode', args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    cwd: job.cwd, env, signal, onStdout: text => {
      output = (output + text).slice(-2000);
      url ??= /server listening on (http:\/\/127\.0\.0\.1:[1-9]\d*)[ \t]*\r?\n/i.exec(output)?.[1];
    },
  }).catch(() => undefined).finally(() => { exited = true; });
  const close = async () => { stop.abort(); await processExit; };
  try {
    while (!url && !exited) await delay(100, undefined, { signal: readySignal });
    if (!url || exited) throw new Error('OpenCode MCP server did not start.');
    const inventory = new URL('/api/mcp', url);
    inventory.searchParams.set('location[directory]', job.cwd);
    const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') };
    while (!exited) {
      const response = await fetch(inventory, { headers, signal: readySignal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('OpenCode MCP inventory returned HTTP ' + response.status + '.');
      }
      const payload = await response.json() as { data: { name: string; status: { status: string } }[] };
      const connected = new Set(payload.data.filter(server => server.status.status === 'connected').map(server => server.name));
      if (names.every(name => connected.has(name))) return { url, env, close };
      await delay(200, undefined, { signal: readySignal });
    }
    throw new Error('OpenCode exited while connecting project MCP.');
  } catch (error) {
    await close();
    if (readySignal.aborted && !job.signal.aborted) throw new Error('OpenCode project MCP did not connect before startup timed out.');
    throw error;
  }
}
