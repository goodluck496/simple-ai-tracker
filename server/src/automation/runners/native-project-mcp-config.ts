import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { RunnerId, type AgentJob } from '../../../../shared/automation/contracts.js';
import { RunWorkspace } from '../worker/run-workspace.js';
import type { ProcessExecutor } from './process-executor.js';
import { TaskEnvironment } from './task-environment.js';
import { openOpenCodeMcpSession } from './opencode-mcp-session.js';

export const bridgedMcpRunners: ReadonlySet<RunnerId> = new Set([
  RunnerId.Antigravity, RunnerId.OpenCode, RunnerId.DeepSeekHarness,
]);

export async function configureNativeProjectMcp(
  runner: RunnerId, job: AgentJob, urls: Record<string, string>, args: string[], executor: Pick<ProcessExecutor, 'run'>,
): Promise<{ env?: NodeJS.ProcessEnv; close(): Promise<void> }> {
  const endpoints = Object.entries(urls).map(([name, url]) => {
    const key = 'sat_' + name;
    return [key.length <= 32 ? key : key.slice(0, 19) + '_' + createHash('sha256').update(key).digest('hex').slice(0, 12), url];
  });
  if (runner === RunnerId.Antigravity) {
    const directory = await RunWorkspace.localDirectory(job.cwd, '.agents');
    const close = await overlay(path.join(directory, 'mcp_config.json'), ['mcpServers'],
      Object.fromEntries(endpoints.map(([name, serverUrl]) => [name, { serverUrl }])));
    return { close };
  }
  if (runner === RunnerId.OpenCode) {
    let diagnostics = '';
    const version = await executor.run({
      command: runner, args: ['--version'], cwd: job.cwd, signal: job.signal, env: TaskEnvironment.create(),
      onStderr: text => { diagnostics = (diagnostics + text).slice(-2000); },
    });
    const major = /\bv?(\d+)\.\d+\.\d+\b/.exec(version || diagnostics)?.[1];
    if (!major) throw new Error('Cannot determine OpenCode MCP configuration format.');
    const v2 = Number(major) >= 2;
    const directory = await RunWorkspace.localDirectory(job.cwd, '.opencode');
    const jsonc = path.join(directory, 'opencode.jsonc');
    const file = await readConfig(jsonc) === undefined ? path.join(directory, 'opencode.json') : jsonc;
    const restore = await overlay(file, v2 ? ['mcp', 'servers'] : ['mcp'],
      Object.fromEntries(endpoints.map(([name, url]) => [name, {
        type: 'remote', url, oauth: false, ...(v2 ? { codemode: false, disabled: false } : { enabled: true }),
      }])));
    if (!v2) return { close: restore };
    try {
      const session = await openOpenCodeMcpSession(job, endpoints.map(([name]) => name), executor);
      args.unshift('--server', session.url);
      return { env: session.env, close: async () => {
        try { await session.close(); } finally { await restore(); }
      } };
    } catch (error) {
      await restore();
      throw error;
    }
  }
  if (runner !== RunnerId.DeepSeekHarness) throw new Error('Unsupported native project MCP runner.');
  const directory = await RunWorkspace.localDirectory(job.cwd, '.sat');
  const file = path.join(directory, 'dsh-mcp.patch.yml');
  // JSON is also valid YAML. Insert at the profile root so the agent inherits the tools.
  const patch = [{ insert: endpoints.map(([serverName, url]) => ({
    id: 'mcp-' + serverName, name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName, transport: 'streamable-http', url, failOnStartupError: true },
  })) }];
  const restore = await temporaryConfig(file, await readConfig(file), JSON.stringify(patch));
  args.splice(2, 0, '--patch', file);
  return { close: restore };
}

async function readConfig(file: string): Promise<string | undefined> {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error('MCP configuration must be a regular file: ' + path.basename(file));
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function overlay(file: string, keys: string[], entries: Record<string, unknown>) {
  const original = await readConfig(file);
  const errors: ParseError[] = [];
  const config: unknown = original === undefined ? {} : parse(original, errors, { allowTrailingComma: true });
  if (errors.length || !isRecord(config)) throw new Error('Invalid MCP configuration: ' + path.basename(file));
  let target = config;
  for (const key of keys) {
    const child = target[key] ?? {};
    if (!isRecord(child)) throw new Error('Invalid MCP configuration section: ' + key);
    target[key] = child;
    target = child;
  }
  for (const name of Object.keys(entries)) {
    if (Object.hasOwn(target, name)) throw new Error('Project MCP configuration name is already in use: ' + name);
  }
  Object.assign(target, entries);
  return temporaryConfig(file, original, JSON.stringify(config, null, 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function temporaryConfig(file: string, original: string | undefined, text: string): Promise<() => Promise<void>> {
  await RunWorkspace.atomicText(file, text);
  return async () => {
    if (await readConfig(file) !== text) return;
    if (original === undefined) await fs.unlink(file);
    else await RunWorkspace.atomicText(file, original);
  };
}
