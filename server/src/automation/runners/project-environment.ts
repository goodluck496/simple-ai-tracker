import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RunnerId, type AgentJob } from '../../../../shared/automation/contracts.js';
import { TaskEnvironment } from './task-environment.js';

type Server = NonNullable<AgentJob['projectMcp']>[number];
interface FileRule { path: string; roles?: string[]; }
interface Manifest { version: 1; instructions?: FileRule[]; skills?: FileRule[]; mcp?: (Server & { roles?: string[] })[]; }
const LIMIT = 48000;
const ROOT_FILES = ['AGENTS.md', 'AGENT_INSTRUCTIONS.md', 'CLAUDE.md'];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);

/** Load policy before a model call. Receipts contain identities, never file bodies or secrets. */
export class ProjectEnvironment {
  public constructor(private readonly probe = ProjectEnvironment.probe) {}
  public async prepare(job: AgentJob, progress: (text: string) => void): Promise<AgentJob> {
    const root = await fs.realpath(job.cwd);
    const safe = async (relative: string): Promise<string> => {
      if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..')) throw new Error('Environment file must use a relative project path.');
      const target = await fs.realpath(path.join(root, relative));
      const resolved = path.relative(root, target);
      if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error('Environment file escapes worktree.');
      if (!(await fs.stat(target)).isFile()) throw new Error('Environment entry must be a file.');
      return target;
    };
    const read = async (relative: string) => {
      const target = await safe(relative);
      if ((await fs.stat(target)).size > LIMIT * 4) throw new Error('Environment file exceeds context limit: ' + relative);
      return fs.readFile(target, 'utf8');
    };
    let manifest: Manifest = { version: 1 };
    let manifestHash: string | undefined;
    try {
      await fs.lstat(path.join(root, 'docs/agent-environment.json'));
      const text = await read('docs/agent-environment.json'); manifestHash = digest(text);
      manifest = JSON.parse(text) as Manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A present profile with a missing target is an error, not an absent profile.
      try { await fs.lstat(path.join(root, 'docs/agent-environment.json')); throw new Error('Environment profile target is missing.'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ENOENT') throw check; }
    }
    if (!manifest || manifest.version !== 1 || Object.keys(manifest).some(k => !['version', 'instructions', 'skills', 'mcp'].includes(k))) throw new Error('Invalid environment profile version or field.');
    const selected = (rule: { roles?: string[] }) => !rule.roles || rule.roles.includes(job.profile.role);
    const rules: FileRule[] = [];
    for (const file of ROOT_FILES) {
      try { await fs.lstat(path.join(root, file)); rules.push({ path: file }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const key of ['instructions', 'skills'] as const) {
      const entries = manifest[key] ?? [];
      if (!Array.isArray(entries) || entries.length > 32) throw new Error('Invalid environment file list.');
      for (const entry of entries) {
        if (!entry || typeof entry.path !== 'string' || (entry.roles !== undefined && !strings(entry.roles)) || Object.keys(entry).some(k => !['path', 'roles'].includes(k))) throw new Error('Invalid environment file rule.');
        if (selected(entry)) rules.push(entry);
      }
    }
    const receipts: { path: string; sha256: string; chars: number }[] = [];
    const texts: string[] = [];
    let total = 0;
    for (const file of [...new Set(rules.map(r => r.path))]) {
      const text = await read(file); total += text.length;
      if (total > LIMIT) throw new Error('Required project instructions exceed 48000 characters; select fewer skills. Nothing was truncated.');
      receipts.push({ path: file, sha256: digest(text), chars: text.length });
      texts.push('--- Project file: ' + file + ' ---\n' + text);
    }
    const servers = manifest.mcp ?? [];
    if (!Array.isArray(servers) || servers.length > 12) throw new Error('Invalid project MCP list.');
    const configured: Server[] = [];
    const names = new Set<string>();
    for (const server of servers) {
      if (!server || !/^[a-zA-Z][\w-]*$/.test(server.name) || ['codegraph', 'simple-ai-tracker'].includes(server.name)
        || names.has(server.name) || typeof server.command !== 'string' || !server.command || !strings(server.tools)
        || !Array.isArray(server.args) || !server.args.every(v => typeof v === 'string')
        || !Array.isArray(server.envVars) || !server.envVars.every(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v))
        || (server.roles !== undefined && !strings(server.roles))
        || Object.keys(server).some(k => !['name', 'command', 'args', 'envVars', 'tools', 'roles'].includes(k))) throw new Error('Invalid project MCP rule.');
      names.add(server.name);
      if (!selected(server)) continue;
      if (job.profile.runner !== RunnerId.Codex && job.profile.runner !== RunnerId.ModelApi) throw new Error('Managed project MCP requires Codex or Model API/Ollama; this CLI adapter does not support isolated project tools. No model was called.');
      const environment = TaskEnvironment.create();
      for (const name of server.envVars) if (!environment[name]) throw new Error('Missing or host-reserved project MCP environment variable: ' + name);
      const bind = (value: string) => value.replaceAll('{worktreeRoot}', root);
      const bound = { name: server.name, command: bind(server.command), args: server.args.map(bind), envVars: server.envVars, tools: server.tools };
      await this.probe(bound, root, job.signal);
      configured.push(bound);
      progress('MCP preflight ' + server.name + ': initialize/listTools OK; tools=' + server.tools.join(', ') + '\n');
    }
    await fs.mkdir(path.join(root, '.sat'), { recursive: true });
    await fs.writeFile(path.join(root, '.sat', 'environment-' + job.profile.role + '.json'),
      JSON.stringify({ role: job.profile.role, runner: job.profile.runner, manifestHash, files: receipts,
        mcp: configured.map(s => ({ name: s.name, tools: s.tools, status: 'ready' })), checkedAt: new Date().toISOString() }, null, 2), 'utf8');
    for (const file of receipts) progress('Project policy loaded: ' + file.path + ' sha256=' + file.sha256.slice(0, 12) + ' chars=' + file.chars + '\n');
    progress('Environment preflight OK: ' + receipts.length + ' files, ' + configured.length + ' project MCP; role=' + job.profile.role + '\n');
    return { ...job, projectMcp: configured, prompt: job.prompt + (texts.length ? '\nRequired project instructions (loaded by worker, do not reread unchanged files):\n' + texts.join('\n') : '') };
  }
  private static async probe(server: Server, cwd: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const client = new Client({ name: 'sat-environment-preflight', version: '1' });
    const environment = TaskEnvironment.create();
    const env = Object.fromEntries(server.envVars.map(name => [name, environment[name]!]));
    const transport = new StdioClientTransport({ command: server.command, args: server.args, env, cwd, stderr: 'pipe' });
    // Drain local diagnostics without publishing server output or secrets.
    transport.stderr?.on('data', () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { void client.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([(async () => {
        await client.connect(transport);
        const tools = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const result = await client.listTools(cursor ? { cursor } : {});
          for (const tool of result.tools) tools.add(tool.name);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (cursor) throw new Error('MCP tool inventory exceeds preflight page limit.');
        for (const name of server.tools) if (!tools.has(name)) throw new Error('Required MCP tool unavailable: ' + name);
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP preflight timed out.')), 15000); })]);
      signal.throwIfAborted();
    } catch { throw new Error('Project MCP preflight failed: ' + server.name + '. Check transport, credentials and required tool names; no model was called.'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await client.close(); await transport.close(); }
  }
}
