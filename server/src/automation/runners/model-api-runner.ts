import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentRole, RunnerId, ProviderKind, WRITABLE_AGENT_ROLES, AGENT_VERDICTS, AUTOMATION_LIMITS, type AgentJob, type AgentRunner, type RunnerResult } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor, ProcessExecutionError } from './process-executor.js';
import { UsageParser } from './usage-parser.js';
import { TokenMeter, type TokenUsage } from '../../../../shared/automation/token-usage.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';
import { ProjectMcpTools } from './project-mcp-tools.js';
import { AGENT_OUTCOME_SCHEMA } from '../../../../shared/automation/outcome-schema.js';

interface ToolCall { id: string; function: { name: string; arguments: string }; }
interface Message { role: string; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string; }
const MAX_TURNS = AUTOMATION_LIMITS.modelToolTurns;
const MAX_FILE_BYTES = 256 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.sat', '.codegraph', 'node_modules']);
const ModelTool = { ListFiles: 'list_files', ReadFile: 'read_file', RunCheck: 'run_check', WriteFile: 'write_file', EditFile: 'edit_file', Explore: 'explore_code', Checkpoint: 'save_progress', Changes: 'inspect_changes', Project: 'call_project_tool', Finish: 'finish_task' } as const;
const READ_MODEL_TOOLS = [ModelTool.ListFiles, ModelTool.ReadFile, ModelTool.RunCheck, ModelTool.Explore, ModelTool.Checkpoint, ModelTool.Changes];

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
    const messages: Message[] = [{ role: 'system', content: 'Follow the task instructions and return the requested JSON outcome. Use only the supplied tools. Use save_progress(note) to save findings and implementationPlan, not .sat filesystem writes. inspect_changes() lists changed files, inspect_changes(path) reads a focused current Git diff.' }, { role: 'user', content: contents.length > 1 ? contents : job.prompt }];
    const names: string[] = job.profile.role === AgentRole.VisualValidator ? [ModelTool.Finish] : [...READ_MODEL_TOOLS.filter(name => name !== ModelTool.RunCheck || job.settings.checks.length > 0), ...(job.projectMcp?.length ? [ModelTool.Project] : []), ...(writable ? [ModelTool.WriteFile, ModelTool.EditFile] : []), ModelTool.Finish];
    messages.push({ role: 'system', content: 'When the assigned work is finished or blocked, call finish_task with the actual verdict and evidence as structured arguments. It ends this stage immediately; no prose final answer or extra confirmation is needed. Never report pass when required work or checks are incomplete. The worker independently validates changes and configured checks.' });
    if (job.projectMcp?.length) messages.push({ role: 'system', content: 'Approved project MCP tools: ' + JSON.stringify(job.projectMcp.map(server => ({ server: server.name, tools: server.tools }))) + '. Call them using call_project_tool(server, tool, arguments). Non-text content is reported as omitted; never claim to have inspected an omitted image.' });
    const parameters = (name: string) => {
      const fields: Record<string, string[]> = { list_files: ['path'], read_file: ['path', 'startLine', 'endLine'], run_check: ['index'],
        write_file: ['path', 'content'], edit_file: ['path', 'oldText', 'newText'], explore_code: ['symbol'], save_progress: ['note'], inspect_changes: ['path'], call_project_tool: ['server', 'tool', 'arguments'] };
      const definitions: Record<string, unknown> = { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' }, note: { type: 'object' },
        path: { type: 'string' }, content: { type: 'string' }, index: { type: 'integer', enum: job.settings.checks.map((_, index) => index) }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, oldText: { type: 'string' }, newText: { type: 'string' }, symbol: { type: 'string' } };
      return { type: 'object', properties: Object.fromEntries(fields[name].map(field => [field, definitions[field]])),
        ...(name === ModelTool.RunCheck ? { required: ['index'] } : {}), additionalProperties: false };
    };
    const tools = names.map((name) => ({ type: 'function', function: { name,
      description: name === ModelTool.Finish ? 'Finish this assigned stage with a truthful structured outcome. Use pass only for completed work with evidence; otherwise blocked/questions/changes_requested. Include the actual Russian commitMessage for source changes. Call alone, after other tools have completed.'
        : name === ModelTool.RunCheck ? `Run a configured check by its zero-based index. Available: ${job.settings.checks.map((check, index) => `${index}: ${CompactProgress.command(check.command, check.args)}`).join('; ') || 'none'}. Failures return exitCode and stdout/stderr evidence; inspect failing test names, expected/actual values before editing.`
        : name === ModelTool.Checkpoint ? 'Save a short prose note to the task through the worker. If no plan exists, save implementationPlan steps before changing source. No code or raw output.'
        : name === ModelTool.Changes ? 'Inspect current Git changes: omit path for filenames only, provide one relative path for bounded diff.'
        : name === ModelTool.Project ? 'Call one explicitly approved project MCP tool with structured arguments. The response is bounded and non-text artifacts are omitted.'
        : name === ModelTool.ReadFile ? 'Read one source range of at most 40 lines using startLine/endLine.'
        : name === ModelTool.EditFile ? 'Patch an existing file by replacing exactly one oldText fragment with newText.'
        : name === ModelTool.WriteFile ? 'Create a new file only; use edit_file for existing files.'
        : name === ModelTool.Explore ? 'Use CodeGraph to inspect exactly one symbol such as ExactClass.method.' : `${name} relative to the project worktree.`,
      parameters: name === ModelTool.Finish ? AGENT_OUTCOME_SCHEMA : parameters(name) } }));
    let usage: TokenUsage | undefined; let missingRequests = 0;
    let calls = 0;
    let formatting = false; let formattingAttempts = 0;
    let finalFormat: 'json_schema' | 'json_object' | 'prompt' = 'json_schema';
    const project = new ProjectMcpTools(job);
    try {
    for (let turn = 0; job.trustedExecution || formatting || turn < Math.min(MAX_TURNS, (job.maxToolCalls ?? MAX_TURNS) + 1); turn += 1) {
      job.signal.throwIfAborted();
      const response = await this.request(url, { method: 'POST', signal: job.signal,
        headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify({ model: job.profile.model, messages,
          ...(formatting ? finalFormat === 'json_schema'
            ? { response_format: { type: 'json_schema', json_schema: { name: 'agent_outcome', strict: true, schema: AGENT_OUTCOME_SCHEMA } } }
            : finalFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}
            : tools.length ? { tools } : {}),
          ...(job.connection.reasoningEffort ? { reasoning_effort: job.connection.reasoningEffort } : {}), stream: false }) });
      if (!response.ok) {
        const error = (await response.text()).slice(0, 2000);
        if (formatting && response.status === 400 && finalFormat !== 'prompt' && /response_format|json_schema|schema|json_object/i.test(error)) {
          finalFormat = finalFormat === 'json_schema' ? 'json_object' : 'prompt';
          onProgress('Провайдер не поддерживает выбранный формат ответа; оформление продолжается в совместимом режиме без повторного запуска инструментов.\n');
          continue;
        }
        throw new Error(`Provider HTTP ${response.status}: ${error}`);
      }
      const payload = await response.json() as { usage?: unknown; choices?: { message: Message; finish_reason?: string }[] };
      const reported = UsageParser.compatible(payload.usage);
      if (reported) usage = TokenMeter.add(usage, reported); else missingRequests++;
      if (usage) { usage = { ...usage, missingRequests }; job.onUsage?.(usage); }
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error('Provider returned no assistant message.');
      messages.push(message);
      if (formatting || !message.tool_calls?.length) {
        let finalText: string | undefined;
        try {
          if (message.tool_calls?.length) throw new Error('Tools are unavailable during final formatting.');
          if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('Empty final answer.');
          const clean = message.content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
          const parsed = JSON.parse(clean);
          if (!parsed || !AGENT_VERDICTS.includes(parsed.verdict) || typeof parsed.summary !== 'string') throw new Error('Missing verdict or summary.');
          finalText = JSON.stringify(parsed);
        } catch {
          if (formattingAttempts >= 2) throw new Error(`Final result formatting failed after two repair attempts (finish_reason=${payload.choices?.[0]?.finish_reason ?? 'unknown'}). Worktree and checkpoint notes are retained; no development restart was performed.`);
          formatting = true; formattingAttempts++;
          onProgress(`Оформление итогового ответа по схеме: попытка ${formattingAttempts}. Рабочая папка и разговор сохранены; инструменты повторно не запускаются.\n`);
          messages.push({ role: 'user', content: 'The final response must be one JSON object matching the supplied schema. This is only a formatting correction in the same conversation: preserve the actual verdict and evidence from your work and tool results; do not invent success, new edits or successful checks. Return blocked if work is incomplete or evidence is missing. Do not call tools or repeat investigation. Put the actual Russian commit subject in commitMessage for developer/designer as instructed in the original task; other roles use an empty string. Use empty questions/decomposition arrays and empty plan when they do not apply.' });
          continue;
        }
        await job.waitForPreparation?.();
        job.signal.throwIfAborted();
        return { text: finalText, usage };
      }
      for (const call of message.tool_calls) {
        if (call.function.name !== ModelTool.Finish && ++calls > (job.maxToolCalls ?? MAX_TURNS) && !job.trustedExecution) throw new Error('Model tool-call limit exceeded.');
        if (!names.includes(call.function.name)) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error: `Инструмент ${call.function.name} недоступен для роли ${job.profile.role}. Доступные инструменты: ${names.join(', ')}. Роль ${job.profile.role} не может модифицировать файлы. Если проверки не пройдены, вызовите finish_task с вердиктом changes_requested.`
            })
          });
          onProgress(`Модель запросила недоступный инструмент ${call.function.name} для роли ${job.profile.role}. Возвращено предупреждение.\n`);
          continue;
        }
        let args: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(call.function.arguments);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch { /* Invalid arguments become a tool error with no raw payload in progress. */ }
        const label = CompactProgress.apiTool(call.function.name, args ?? {});
        onProgress(`Инструмент ${label}: выполняется.\n`);
        // Infrastructure failures must stop the conversation, not become retryable tool errors.
        if (([ModelTool.RunCheck, ModelTool.WriteFile, ModelTool.EditFile, ModelTool.Project, ModelTool.Finish] as string[]).includes(call.function.name)) {
          await job.waitForPreparation?.();
        }
        job.signal.throwIfAborted();
        let result: unknown;
        try {
          if (!args) throw new Error('Tool arguments must be a JSON object.');
          if (call.function.name === ModelTool.Finish) {
            if (message.tool_calls.length !== 1) throw new Error('Call finish_task alone after all other operations complete.');
            if (!AGENT_VERDICTS.some(verdict => verdict === args.verdict) || typeof args.summary !== 'string') throw new Error('finish_task requires an actual verdict and summary.');
            onProgress('Итог этапа принят через finish_task; worker проверяет и сохраняет результат.\n');
            return { text: JSON.stringify(args), usage };
          }
          result = call.function.name === ModelTool.Project
            ? await project.call(args.server, args.tool, args.arguments)
            : await this.tool(job, call.function.name, args);
        }
        catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
        const error = result && typeof result === 'object' ? (result as { error?: unknown }).error : undefined;
        const read = call.function.name === ModelTool.ReadFile && result && typeof result === 'object' && 'startLine' in result
          ? result as Record<string, unknown> : undefined;
        const completedLabel = read ? CompactProgress.apiTool(call.function.name, read) : label;
        onProgress(`Инструмент ${completedLabel}: ${error ? 'ошибка' : 'завершён'}${read?.limited ? ' (диапазон ограничен 40 строками)' : ''}.\n`);
        if (error) onProgress(CompactProgress.diagnostics(`Error: ${String(error)}`) + '\n');
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error('Model tool-call limit reached.');
    } finally { await project.close(); }
  }

  private async tool(job: AgentJob, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === ModelTool.Checkpoint) {
      if (!job.onCheckpoint) throw new Error('Worker checkpoint channel is unavailable.');
      await job.onCheckpoint(args.note); return { saved: true };
    }
    if (name === ModelTool.Changes) {
      if (!job.baseSha) throw new Error('Review baseline is unavailable.');
      const file = typeof args.path === 'string' ? args.path : undefined;
      if (file) await this.safePath(job.cwd, file, true);
      const output = await this.executor.run({ command: 'git', args: ['diff', ...(file ? [] : ['--name-only']), job.baseSha, '--', ...(file ? [`:(literal)${file}`] : ['.', ':!.sat'])], cwd: job.cwd, signal: job.signal, maxOutputChars: 7000 });
      return { content: output.slice(0, 6000), limited: output.length > 6000, advice: 'Read only the relevant source ranges for current code.' };
    }
    if (name === ModelTool.Explore) {
      if (typeof args.symbol !== 'string' || !/^[\p{L}_$][\p{L}\p{N}_$]*(?:[.:][\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(args.symbol)) throw new Error('Explore exactly one symbol, such as ExactClass.method.');
      // CodeGraph already scopes this query to one symbol/file. Keep its complete
      // source and call paths: a small tail cap loses the requested symbol, while
      // rejecting a valid answer makes the model repeat navigation and reads.
      const source = await this.executor.run({ command: 'codegraph', args: ['explore', '--path', job.cwd, '--max-files', '1', args.symbol], cwd: job.cwd, signal: job.signal, maxOutputChars: Number.POSITIVE_INFINITY });
      return source;
    }
    if (name === ModelTool.RunCheck) {
      if (!Number.isInteger(args.index)) throw new Error('Check index must be an integer.');
      const check = job.settings.checks[Number(args.index)];
      if (!check) throw new Error(`Unknown configured check #${args.index}. Available zero-based indices: ${job.settings.checks.map((entry, index) => `${index}: ${CompactProgress.command(entry.command, entry.args)}`).join('; ') || 'none'}.`);
      try { await this.executor.run({ ...check, cwd: job.cwd, signal: job.signal, compactProgress: true }); }
      catch (error) {
        job.signal.throwIfAborted();
        if (!(error instanceof ProcessExecutionError)) throw error;
        const limit = 16000;
        return { exitCode: error.exitCode, error: error.message, checkIndex: args.index,
          stdout: error.stdout.slice(-limit), stderr: error.stderr.slice(-limit),
          outputLimited: error.stdout.length > limit || error.stderr.length > limit };
      }
      return { exitCode: 0 };
    }
    const relative = typeof args.path === 'string' ? args.path : '.';
    const file = await this.safePath(job.cwd, relative, name === ModelTool.WriteFile);
    if (name === ModelTool.ListFiles) return (await fs.readdir(file, { withFileTypes: true }))
      .filter((entry) => !EXCLUDED_DIRECTORY_NAMES.has(entry.name)).slice(0, 200).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
    if (name === ModelTool.ReadFile) {
      if ((await fs.stat(file)).size > MAX_FILE_BYTES) throw new Error('File is too large; read a smaller file.');
      const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
      const start = Number(args.startLine ?? 1); const requestedEnd = Number(args.endLine ?? start + 39);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 1 || requestedEnd < start)
        throw new Error(`Invalid read range for ${relative}: startLine=${start}, endLine=${requestedEnd}. Use integer lines with 1 <= startLine <= endLine; up to 40 lines are returned.`);
      if (start > lines.length) throw new Error(`Read starts beyond EOF for ${relative}: requested line ${start}, file has ${lines.length} lines.`);
      const end = Math.min(requestedEnd, start + 39, lines.length);
      return { path: relative, startLine: start, endLine: end, totalLines: lines.length,
        ...(requestedEnd - start >= 40 ? { limited: true, requestedEndLine: requestedEnd, nextStartLine: end < lines.length ? end + 1 : undefined } : {}),
        content: lines.slice(start - 1, end).join('\n') };
    }
    if (name === ModelTool.EditFile) {
      if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new Error('edit_file requires nonempty oldText and newText.');
      const before = await fs.readFile(file, 'utf8');
      // read_file returns LF ranges even when the Windows file uses CRLF.
      // Normalize only line endings for matching, then map back to original
      // offsets so untouched text (including mixed endings) stays byte-identical.
      const source = before.replace(/\r\n/g, '\n');
      const oldText = args.oldText.replace(/\r\n/g, '\n');
      const start = source.indexOf(oldText);
      const duplicate = start >= 0 && source.indexOf(oldText, start + 1) >= 0;
      if (start < 0 || duplicate) throw new Error(`Patch must match exactly one existing fragment in ${relative}; found ${start < 0 ? '0' : 'multiple'} matches. Read the current file range and use a unique exact fragment; do not retry the same oldText.`);
      const originalOffset = (target: number) => {
        let original = 0;
        for (let normalized = 0; normalized < target; normalized++, original++) {
          if (before[original] === '\r' && before[original + 1] === '\n') original++;
        }
        return original;
      };
      const from = originalOffset(start); const to = originalOffset(start + oldText.length);
      const newline = before.slice(from, to).includes('\r\n') || !oldText.includes('\n') && before.includes('\r\n') ? '\r\n' : '\n';
      const replacement = args.newText.replace(/\r\n/g, '\n').replace(/\n/g, newline);
      await fs.writeFile(file, before.slice(0, from) + replacement + before.slice(to), 'utf8');
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
