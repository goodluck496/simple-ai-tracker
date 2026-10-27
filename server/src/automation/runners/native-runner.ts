import fs from 'node:fs/promises';
import path from 'node:path';
import { RunnerId, type AgentJob, type AgentRunner, type RunnerResult } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor } from './process-executor.js';
import { NativeUsageStream, UsageParser } from './usage-parser.js';
import { AGENT_TRACKER_READ_TOOLS, AGENT_TRACKER_SERVER } from '../../../../shared/automation/tracker-access.js';
import { TaskEnvironment } from './task-environment.js';
import { AGENT_OUTCOME_SCHEMA } from '../../../../shared/automation/outcome-schema.js';
import { NativeExecutable } from './native-executable.js';

interface Envelope { type?: string; is_error?: boolean; result?: string; response?: string; status?: string; session_id?: string; conversation_id?: string; item?: { type?: string; text?: string }; part?: { type?: string; text?: string }; }
const NATIVE_SUCCESS_STATUSES = new Set(['SUCCESS', 'success']);

export class NativeAgentRunner implements AgentRunner {
  public constructor(public readonly id: RunnerId, private readonly executor = new ProcessExecutor()) {}
  public async run(job: AgentJob, onProgress: (text: string) => void): Promise<RunnerResult> {
    const promptDir = path.join(job.cwd, '.sat');
    await fs.mkdir(promptDir, { recursive: true });
    const promptFile = path.join(promptDir, 'instructions.md');
    await fs.writeFile(promptFile, job.prompt, 'utf8');
    const brief = 'Read .sat/instructions.md and execute that task. Return only the requested JSON outcome.';
    let command = ''; let args: string[] = []; let stdin: string | undefined;
    const model = job.profile.model;
    const schemaPath = path.join(promptDir, 'outcome-schema.json');
    if (this.id === RunnerId.Codex) await fs.writeFile(schemaPath, JSON.stringify(AGENT_OUTCOME_SCHEMA), 'utf8');
    switch (this.id) {
      case RunnerId.Codex: command = RunnerId.Codex; args = ['exec', '--json', '--output-schema', schemaPath, '--sandbox', 'workspace-write', '--model', model,
        '-c', 'tool_output_token_limit=1500',
        '-c', `mcp_servers.${AGENT_TRACKER_SERVER}.enabled_tools=${JSON.stringify(AGENT_TRACKER_READ_TOOLS)}`,
        '-c', `mcp_servers.${AGENT_TRACKER_SERVER}.default_tools_approval_mode="auto"`, '-']; stdin = job.prompt; break;
      case RunnerId.ClaudeCode: command = 'claude'; args = ['-p', '--output-format', 'json', '--model', model]; stdin = job.prompt; break;
      case RunnerId.OpenCode: command = RunnerId.OpenCode; args = ['run', '--format', 'json', '--model', model, brief]; break;
      case RunnerId.DeepSeekHarness: command = 'dsh'; args = ['--profile', job.profile.nativeProfile!, brief]; break;
      case RunnerId.Antigravity: command = NativeExecutable.antigravity(); args = ['-p', brief, '--output-format', 'json', '--model', model]; break;
      case RunnerId.Custom: {
        command = job.profile.command!;
        const values: Record<string, string> = { promptFile, model, cwd: job.cwd, role: job.profile.role, provider: job.connection.id };
        args = (job.profile.args ?? []).map((argument) => argument.replace(/\{(\w+)\}/g, (_, key: string) => {
          if (!(key in values)) throw new Error(`Unknown runner placeholder: ${key}`);
          return values[key];
        }));
        break;
      }
      default: throw new Error(`Not a native runner: ${this.id}`);
    }
    if (this.id === RunnerId.Codex) {
      // Task context is already supplied by the worker. Do not inherit unrelated
      // account-wide servers (and their large tool descriptions) in every role.
      const inventory = await this.executor.run({ command, args: ['mcp', 'list', '--json'], cwd: job.cwd,
        env: TaskEnvironment.create(), signal: job.signal, maxOutputChars: 100000 });
      let servers: { name: string; enabled?: boolean; transport?: { type?: string; command?: string; url?: string } }[];
      try {
        const parsed: unknown = JSON.parse(inventory);
        if (!Array.isArray(parsed) || parsed.some(server => !server || typeof server.name !== 'string' || !/^[\w-]+$/.test(server.name))) throw new Error();
        servers = parsed;
      } catch { throw new Error('Cannot inspect Codex MCP configuration; refusing an uncontrolled nested-agent context.'); }
      let indexed = false;
      try { indexed = (await fs.stat(path.join(job.cwd, '.codegraph'))).isDirectory(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Retain the repository's required code navigation only when it is indexed.
      for (const server of servers) if (server.enabled !== false && (server.name !== 'codegraph' || !indexed)) {
        // Desktop-injected servers may not exist in config.toml. An enabled-only
        // override would create a transport-less entry and make Codex refuse startup.
        if (server.transport?.type === 'stdio' && server.transport.command) args.push('-c', `mcp_servers.${server.name}.command=${JSON.stringify(server.transport.command)}`);
        if (server.transport?.type === 'streamable_http' && server.transport.url) args.push('-c', `mcp_servers.${server.name}.url=${JSON.stringify(server.transport.url)}`);
        args.push('-c', `mcp_servers.${server.name}.enabled=false`);
      }
    }
    if (this.id !== RunnerId.Custom) args.push(...(job.profile.args ?? []));
    const limitController = new AbortController();
    const toolIds = new Set<string>();
    const meter = new NativeUsageStream(this.id, sample => job.onUsage?.(sample, { terminal: true }), (value) => {
      const record = value as { type?: string; item?: { id?: string; type?: string } };
      if (job.maxToolCalls && record.item?.id && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(record.item.type ?? '')) {
        toolIds.add(record.item.id);
        if (toolIds.size > job.maxToolCalls) limitController.abort(new Error(`Agent tool-call limit exceeded (${job.maxToolCalls}). Saved work is retained; inspect the current step before resuming.`));
      }
    });
    const signal = AbortSignal.any([job.signal, limitController.signal]);
    let raw: string;
    try { raw = await this.executor.run({ command, args, cwd: job.cwd, stdin, env: TaskEnvironment.create(), signal, onProgress, onStdout: (text) => meter.push(text) }); }
    catch (error) { if (limitController.signal.aborted) throw limitController.signal.reason; throw error; }
    finally { meter.finish(); }
    // Some executors and formatted JSON outputs provide only the final complete document.
    if (!meter.usage) {
      try { const usage = UsageParser.native(this.id, JSON.parse(raw)); if (usage) { meter.usage = usage; job.onUsage?.(usage); } }
      catch { /* JSONL is consumed by the stream parser. */ }
    }
    if (this.id === RunnerId.Custom) return { text: raw.trim() };
    let answer = ''; let sessionId: string | undefined;
    const records: string[] = [];
    try { JSON.parse(raw); records.push(raw); } catch { records.push(...raw.split(/\r?\n/)); }
    for (const line of records) {
      let envelope: Envelope;
      try { envelope = JSON.parse(line) as Envelope; } catch { continue; }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue;
      if (envelope.is_error || envelope.type === 'turn.failed' || (envelope.status && !NATIVE_SUCCESS_STATUSES.has(envelope.status))) throw new Error(`Native agent failed: ${line.slice(0, 2000)}`);
      sessionId = envelope.session_id ?? envelope.conversation_id ?? sessionId;
      if (typeof envelope.result === 'string') answer = envelope.result;
      if (typeof envelope.response === 'string') answer = envelope.response;
      if (envelope.item?.type === 'agent_message' && envelope.item.text) answer = envelope.item.text;
      if (envelope.type === 'text' && envelope.part?.text) answer += envelope.part.text;
    }
    // DeepSeek/custom profiles may use a different event envelope; preserve output for strict outcome parsing.
    return { text: answer || raw.trim(), sessionId, usage: meter.usage };
  }
}
