import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { bindProjectMcp, listProjectMcpTools, projectMcpTransport } from './mcp-transport.js';
import { validMcp } from '../../../../shared/automation/project-mcp.js';
import { RunnerId, type AgentJob } from '../../../../shared/automation/contracts.js';
import { SKILL_LIMITS } from '../../../../shared/automation/skills.js';
import { RunWorkspace } from '../worker/run-workspace.js';
import { bridgedMcpRunners } from './native-project-mcp-config.js';

type Server = NonNullable<AgentJob['projectMcp']>[number];
interface FileRule { path: string; roles?: string[]; }
interface Manifest { version: 1; instructions?: FileRule[]; skills?: FileRule[]; mcp?: (Server & { roles?: string[] })[]; }
const LIMIT = 48000;
const ROOT_FILES = ['AGENTS.md', 'AGENT_INSTRUCTIONS.md', 'CLAUDE.md'];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);

/** Load policy before a model call. Receipts contain identities, never file bodies or secrets. */
export class ProjectEnvironment {
  public constructor(private readonly probe: (server: Server, cwd: string, signal: AbortSignal) => Promise<unknown> = ProjectEnvironment.probe) {}
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
    if (manifest.mcp !== undefined && !Array.isArray(manifest.mcp)) throw new Error('Invalid project MCP list.');
    const servers = [...(manifest.mcp ?? []), ...(job.settings?.mcpServers ?? [])];
    if (!Array.isArray(servers) || servers.length > 12) throw new Error('Invalid project MCP list.');
    const configured: Server[] = [];
    const names = new Set<string>();
    for (const server of servers) {
      if (!validMcp(server)) throw new Error('Invalid project MCP rule.');
      if (names.has(server.name)) throw new Error('Duplicate project MCP name in settings or manifest: ' + server.name);
      names.add(server.name);
      if (!selected(server)) continue;
      if (job.profile.runner !== RunnerId.Codex && job.profile.runner !== RunnerId.ModelApi && !bridgedMcpRunners.has(job.profile.runner)) {
        throw new Error('This runner does not support managed project MCP. No model was called.');
      }
      const bound = bindProjectMcp(server, root);
      // A project server can depend on packages installed by worker setup.
      await job.waitForPreparation?.();
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
    let prompt = job.prompt + (texts.length ? '\nRequired project instructions (loaded by worker, do not reread unchanged files):\n' + texts.join('\n') : '');
    if (job.librarySkills?.length) {
      const available = [];
      const native = job.profile.runner !== RunnerId.ModelApi;
      const directory = native ? await RunWorkspace.localDirectory(root, '.sat/skills/' + job.profile.role) : undefined;
      for (const { id, name, description, version, content } of job.librarySkills) {
        if (!/^[\w-]{1,80}$/.test(id) || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid library skill reference.');
        const file = `${id}-v${version}.md`;
        if (directory) await RunWorkspace.atomicText(path.join(directory, file), content);
        const when = description.length > SKILL_LIMITS.promptDescription
          ? description.slice(0, SKILL_LIMITS.promptDescription - 1) + '…'
          : description;
        available.push({ id, name, when, ...(directory ? { path: path.relative(root, path.join(directory, file)).split(path.sep).join('/') } : {}) });
      }
      prompt += '\nAvailable skills for this role. When a description applies, read the corresponding instruction once using '
        + (native ? 'its worktree path' : 'read_skill(id)') + ':\n' + JSON.stringify(available);
    }
    return { ...job, projectMcp: configured, prompt };
  }
  public static async probe(server: Server, cwd: string, signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted();
    const client = new Client({ name: 'sat-environment-preflight', version: '1' });
    const transport = projectMcpTransport(server, cwd);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { void client.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const available = await Promise.race([(async () => {
        await client.connect(transport);
        const tools = new Set((await listProjectMcpTools(client, signal)).map(tool => tool.name));
        for (const name of server.tools) if (!tools.has(name)) throw new Error('Required MCP tool unavailable: ' + name);
        return [...tools].sort();
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP preflight timed out.')), 15000); })]);
      signal.throwIfAborted();
      return available;
    } catch { throw new Error('Project MCP preflight failed: ' + server.name + '. Check transport, credentials and required tool names; no model was called.'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await client.close(); await transport.close(); }
  }
}
