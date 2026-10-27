import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentRole, RunnerId, ProviderKind, WRITABLE_AGENT_ROLES, AUTOMATION_LIMITS, type AgentJob, type AgentRunner, type RunnerResult } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor } from './process-executor.js';
import { UsageParser } from './usage-parser.js';
import { TokenMeter, type TokenUsage } from '../../../../shared/automation/token-usage.js';

interface ToolCall { id: string; function: { name: string; arguments: string }; }
interface Message { role: string; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string; }
const MAX_TURNS = AUTOMATION_LIMITS.modelToolTurns;
const MAX_FILE_BYTES = 256 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.sat', 'node_modules']);
const ModelTool = { ListFiles: 'list_files', ReadFile: 'read_file', RunCheck: 'run_check', WriteFile: 'write_file' } as const;
const READ_MODEL_TOOLS = [ModelTool.ListFiles, ModelTool.ReadFile, ModelTool.RunCheck];

/** A small, bounded tool loop for Ollama and compatible APIs; no shell supplied by the model. */
export class ModelApiRunner implements AgentRunner {
  public readonly id = RunnerId.ModelApi;
  public constructor(private readonly executor = new ProcessExecutor(), private readonly request: typeof fetch = fetch) {}

  public async run(job: AgentJob, onProgress: (text: string) => void): Promise<RunnerResult> {
    const base = job.connection.baseUrl!.replace(/\/$/, '');
    const url = `${base}${job.connection.kind === ProviderKind.Ollama && !base.endsWith('/v1') ? '/v1' : ''}/chat/completions`;
    const secret = job.connection.credentialEnv ? process.env[job.connection.credentialEnv] : undefined;
    if (job.connection.credentialEnv && !secret) throw new Error(`Missing worker environment variable: ${job.connection.credentialEnv}`);
    const writable = WRITABLE_AGENT_ROLES.includes(job.profile.role);
    const contents: unknown[] = [{ type: 'text', text: job.prompt }];
    if (job.profile.role === AgentRole.VisualValidator || job.profile.role === AgentRole.Designer) {
      for (const relative of job.settings.artifactPaths) {
        if (!/\.(png|jpe?g|webp)$/i.test(relative)) continue;
        if (!job.connection.supportsImages) throw new Error('Connection does not support images.');
        const file = await this.safePath(job.cwd, relative);
        const stat = await fs.stat(file);
        if (stat.size > AUTOMATION_LIMITS.imageBytes) throw new Error('Visual artifact exceeds 4 MiB.');
        const mime = /\.png$/i.test(relative) ? 'image/png' : /\.webp$/i.test(relative) ? 'image/webp' : 'image/jpeg';
        contents.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}` } });
      }
      if (job.profile.role === AgentRole.VisualValidator && contents.length < 2) throw new Error('Visual validator requires at least one generated image artifact.');
    }
    const messages: Message[] = [{ role: 'system', content: 'Follow the task instructions and return the requested JSON outcome. Use only the supplied tools.' }, { role: 'user', content: contents.length > 1 ? contents : job.prompt }];
    const names: string[] = job.profile.role === AgentRole.VisualValidator ? [] : [...READ_MODEL_TOOLS, ...(writable ? [ModelTool.WriteFile] : [])];
    const tools = names.map((name) => ({ type: 'function', function: { name,
      description: name === ModelTool.RunCheck ? 'Run a configured check by numeric index.' : `${name} relative to the project worktree.`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, index: { type: 'integer' } }, additionalProperties: false } } }));
    let usage: TokenUsage | undefined; let missingRequests = 0;
    let calls = 0;
    for (let turn = 0; turn < Math.min(MAX_TURNS, (job.maxToolCalls ?? MAX_TURNS) + 1); turn += 1) {
      job.signal.throwIfAborted();
      const response = await this.request(url, { method: 'POST', signal: job.signal,
        headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify({ model: job.profile.model, messages, ...(tools.length ? { tools } : {}),
          ...(job.connection.reasoningEffort ? { reasoning_effort: job.connection.reasoningEffort } : {}), stream: false }) });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
      const payload = await response.json() as { usage?: unknown; choices?: { message: Message; finish_reason?: string }[] };
      const reported = UsageParser.compatible(payload.usage);
      if (reported) usage = TokenMeter.add(usage, reported); else missingRequests++;
      if (usage) { usage = { ...usage, missingRequests }; job.onUsage?.(usage); }
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error('Provider returned no assistant message.');
      messages.push(message);
      if (!message.tool_calls?.length) {
        if (typeof message.content !== 'string' || !message.content.trim()) throw new Error(`Provider returned an empty answer (finish_reason=${payload.choices?.[0]?.finish_reason ?? 'unknown'}). Check context size and reasoning settings.`);
        return { text: message.content, usage };
      }
      for (const call of message.tool_calls) {
        if (++calls > (job.maxToolCalls ?? MAX_TURNS)) throw new Error('Model tool-call limit exceeded.');
        if (!names.includes(call.function.name)) throw new Error('Model requested a tool outside its role.');
        let result: unknown;
        try { result = await this.tool(job, call.function.name, JSON.parse(call.function.arguments) as Record<string, unknown>); }
        catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        onProgress(`${call.function.name}: ${JSON.stringify(result).slice(0, 1000)}`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error('Model tool-call limit reached.');
  }

  private async tool(job: AgentJob, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === ModelTool.RunCheck) {
      if (!Number.isInteger(args.index)) throw new Error('Check index must be an integer.');
      const check = job.settings.checks[Number(args.index)];
      if (!check) throw new Error('Unknown configured check.');
      return this.executor.run({ ...check, cwd: job.cwd, signal: job.signal });
    }
    const relative = typeof args.path === 'string' ? args.path : '.';
    const file = await this.safePath(job.cwd, relative, name === ModelTool.WriteFile);
    if (name === ModelTool.ListFiles) return (await fs.readdir(file, { withFileTypes: true }))
      .filter((entry) => !EXCLUDED_DIRECTORY_NAMES.has(entry.name)).slice(0, 200).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
    if (name === ModelTool.ReadFile) {
      if ((await fs.stat(file)).size > MAX_FILE_BYTES) throw new Error('File is too large; read a smaller file.');
      return fs.readFile(file, 'utf8');
    }
    if (name === ModelTool.WriteFile) {
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new Error('Invalid file content.');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.content, 'utf8');
      return { written: relative };
    }
    throw new Error('Unknown tool.');
  }
  private async safePath(root: string, relative: string, allowMissing = false): Promise<string> {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '.git' || part === '.sat')) throw new Error('Path is not allowed.');
    const resolvedRoot = await fs.realpath(root);
    const target = path.resolve(resolvedRoot, relative);
    const inside = (value: string) => value === resolvedRoot || value.startsWith(`${resolvedRoot}${path.sep}`);
    if (!inside(target)) throw new Error('Path escapes worktree.');
    let ancestor = target;
    while (true) {
      try { if (!inside(await fs.realpath(ancestor))) throw new Error('Symlink escapes worktree.'); break; }
      catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === resolvedRoot) throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    return target;
  }
}
