import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentRole, RunnerId, ProviderKind, WRITABLE_AGENT_ROLES, AUTOMATION_LIMITS, type AgentJob, type AgentRunner, type RunnerResult } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor } from './process-executor.js';
import { UsageParser } from './usage-parser.js';
import { TokenMeter, type TokenUsage } from '../../../../shared/automation/token-usage.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';

interface ToolCall { id: string; function: { name: string; arguments: string }; }
interface Message { role: string; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string; }
const MAX_TURNS = AUTOMATION_LIMITS.modelToolTurns;
const MAX_FILE_BYTES = 256 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.sat', '.codegraph', 'node_modules']);
const ModelTool = { ListFiles: 'list_files', ReadFile: 'read_file', RunCheck: 'run_check', WriteFile: 'write_file', EditFile: 'edit_file', Explore: 'explore_code' } as const;
const READ_MODEL_TOOLS = [ModelTool.ListFiles, ModelTool.ReadFile, ModelTool.RunCheck, ModelTool.Explore];

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
    const names: string[] = job.profile.role === AgentRole.VisualValidator ? [] : [...READ_MODEL_TOOLS, ...(writable ? [ModelTool.WriteFile, ModelTool.EditFile] : [])];
    const tools = names.map((name) => ({ type: 'function', function: { name,
      description: name === ModelTool.RunCheck ? 'Run a configured check by numeric index; success returns only exitCode.'
        : name === ModelTool.ReadFile ? 'Read one source range of at most 40 lines using startLine/endLine.'
        : name === ModelTool.EditFile ? 'Patch an existing file by replacing exactly one oldText fragment with newText.'
        : name === ModelTool.WriteFile ? 'Create a new file only; use edit_file for existing files.'
        : name === ModelTool.Explore ? 'Use CodeGraph to inspect exactly one symbol such as ExactClass.method.' : `${name} relative to the project worktree.`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, index: { type: 'integer' }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, oldText: { type: 'string' }, newText: { type: 'string' }, symbol: { type: 'string' } }, additionalProperties: false } } }));
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
        const error = result && typeof result === 'object' ? (result as { error?: unknown }).error : undefined;
        onProgress(`Инструмент ${call.function.name}: ${error ? 'ошибка' : 'завершён'}.\n`);
        if (error) onProgress(CompactProgress.diagnostics(`Error: ${String(error)}`) + '\n');
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error('Model tool-call limit reached.');
  }

  private async tool(job: AgentJob, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === ModelTool.Explore) {
      if (typeof args.symbol !== 'string' || !/^[\p{L}_$][\p{L}\p{N}_$]*(?:[.:][\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(args.symbol)) throw new Error('Explore exactly one symbol, such as ExactClass.method.');
      const source = await this.executor.run({ command: 'codegraph', args: ['explore', '--path', job.cwd, '--max-files', '1', args.symbol], cwd: job.cwd, signal: job.signal, maxOutputChars: 16000 });
      if (source.length > 6000) throw new Error('Symbol result is too large; read a specific 40-line range instead.');
      return source;
    }
    if (name === ModelTool.RunCheck) {
      if (!Number.isInteger(args.index)) throw new Error('Check index must be an integer.');
      const check = job.settings.checks[Number(args.index)];
      if (!check) throw new Error('Unknown configured check.');
      await this.executor.run({ ...check, cwd: job.cwd, signal: job.signal, compactProgress: true });
      return { exitCode: 0 };
    }
    const relative = typeof args.path === 'string' ? args.path : '.';
    const file = await this.safePath(job.cwd, relative, name === ModelTool.WriteFile);
    if (name === ModelTool.ListFiles) return (await fs.readdir(file, { withFileTypes: true }))
      .filter((entry) => !EXCLUDED_DIRECTORY_NAMES.has(entry.name)).slice(0, 200).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
    if (name === ModelTool.ReadFile) {
      if ((await fs.stat(file)).size > MAX_FILE_BYTES) throw new Error('File is too large; read a smaller file.');
      const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
      const start = Number(args.startLine ?? 1); const end = Number(args.endLine ?? Math.min(lines.length, start + 39));
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 40) throw new Error('Read one range of at most 40 lines.');
      return { path: relative, startLine: start, endLine: Math.min(end, lines.length), totalLines: lines.length, content: lines.slice(start - 1, end).join('\n') };
    }
    if (name === ModelTool.EditFile) {
      if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new Error('edit_file requires nonempty oldText and newText.');
      const before = await fs.readFile(file, 'utf8');
      if (before.split(args.oldText).length !== 2) throw new Error('Patch must match exactly one existing fragment.');
      await fs.writeFile(file, before.replace(args.oldText, () => args.newText as string), 'utf8');
      return { saved: relative, edited: true };
    }
    if (name === ModelTool.WriteFile) {
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new Error('Invalid file content.');
      try { await fs.access(file); throw new Error('Use edit_file for an existing file; write_file only creates new files.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.content, 'utf8');
      return { written: relative };
    }
    throw new Error('Unknown tool.');
  }
  private async safePath(root: string, relative: string, allowMissing = false): Promise<string> {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '.git' || part === '.sat' || part === '.codegraph')) throw new Error('Path is not allowed.');
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
