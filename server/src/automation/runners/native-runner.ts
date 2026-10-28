import fs from 'node:fs/promises';
import path from 'node:path';
import { RunnerId, type AgentJob, type AgentRunner, type RunnerResult } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor } from './process-executor.js';
import { NativeUsageStream, UsageParser } from './usage-parser.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';
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
        '-c', 'tool_output_token_limit=800',
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
      // Match the host worker's transport instead of inheriting an account-wide
      // tracker configuration which may point to a different store/runtime.
      const trackerCommand = process.env.SAT_MCP_COMMAND ?? process.execPath;
      const trackerArgs: unknown = JSON.parse(process.env.SAT_MCP_ARGS ?? JSON.stringify([path.resolve('dist/server/mcp.mjs')]));
      if (!Array.isArray(trackerArgs) || !trackerArgs.every(arg => typeof arg === 'string')) throw new Error('SAT_MCP_ARGS must be a JSON string array.');
      const trackerEnv: Record<string, string> = { SAT_WORKSPACE: process.env.SAT_WORKSPACE ?? 'default' };
      for (const key of ['SAT_HOME', 'SAT_DB_PATH', 'SAT_BACKUP_ENABLED']) {
        const value = process.env[key]; if (value !== undefined) trackerEnv[key] = value;
      }
      args.push('-c', `mcp_servers.${AGENT_TRACKER_SERVER}.command=${JSON.stringify(trackerCommand)}`,
        '-c', `mcp_servers.${AGENT_TRACKER_SERVER}.args=${JSON.stringify(trackerArgs)}`,
        '-c', `mcp_servers.${AGENT_TRACKER_SERVER}.env={${Object.entries(trackerEnv).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`,
        '-c', `mcp_servers.${AGENT_TRACKER_SERVER}.enabled=true`);
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
      if (indexed) {
        const graph = servers.find(s => s.name === 'codegraph');
        if (graph?.transport?.type && graph.transport.type !== 'stdio') throw new Error('Worktree CodeGraph requires a local stdio connection.');
        const executable = NativeExecutable.codegraphMcp(job.cwd);
        args.push('-c', `mcp_servers.codegraph.command=${JSON.stringify(executable.command)}`, '-c', `mcp_servers.codegraph.args=${JSON.stringify(executable.args)}`,
          '-c', 'mcp_servers.codegraph.enabled=true', '-c', 'mcp_servers.codegraph.enabled_tools=["codegraph_explore"]', '-c', 'mcp_servers.codegraph.default_tools_approval_mode="auto"');
      }
      for (const server of job.projectMcp ?? []) {
        const inherited = servers.find(s => s.name === server.name);
        if (inherited && inherited.transport?.type !== 'stdio') throw new Error('Project MCP name conflicts with a non-stdio account server: ' + server.name);
        args.push('-c', `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
          '-c', `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`,
          '-c', `mcp_servers.${server.name}.cwd=${JSON.stringify(job.cwd)}`,
          '-c', `mcp_servers.${server.name}.env_vars=${JSON.stringify(server.envVars)}`,
          '-c', `mcp_servers.${server.name}.enabled_tools=${JSON.stringify(server.tools)}`,
          '-c', `mcp_servers.${server.name}.default_tools_approval_mode="auto"`,
          '-c', `mcp_servers.${server.name}.enabled=true`);
      }
      // Retain the repository's required code navigation only when it is indexed.
      for (const server of servers) if (!(job.projectMcp ?? []).some(s => s.name === server.name) && server.name !== AGENT_TRACKER_SERVER && server.enabled !== false && (server.name !== 'codegraph' || !indexed)) {
        // Desktop-injected servers may not exist in config.toml. An enabled-only
        // override would create a transport-less entry and make Codex refuse startup.
        if (server.transport?.type === 'stdio' && server.transport.command) args.push('-c', `mcp_servers.${server.name}.command=${JSON.stringify(server.transport.command)}`);
        if (server.transport?.type === 'streamable_http' && server.transport.url) args.push('-c', `mcp_servers.${server.name}.url=${JSON.stringify(server.transport.url)}`);
        args.push('-c', `mcp_servers.${server.name}.enabled=false`);
      }
    }
    if (this.id !== RunnerId.Custom) args.push(...(job.profile.args ?? []));
    const toolIds = new Set<string>();
    let toolThresholdReported = false;
    const meter = new NativeUsageStream(this.id, sample => job.onUsage?.(sample, { terminal: true }), (value) => {
      for (const line of CompactProgress.record(value)) onProgress(line + '\n');
      const record = value as { type?: string; item?: { id?: string; type?: string } };
      if (job.maxToolCalls && record.item?.id && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(record.item.type ?? '')) {
        toolIds.add(record.item.id);
        if (toolIds.size > job.maxToolCalls && !toolThresholdReported) {
          toolThresholdReported = true;
          onProgress(`Предупреждение: выполнено более ${job.maxToolCalls} действий. Агент продолжает работу; ограничения времени и общего бюджета сохраняются.\n`);
        }
      }
    });
    let raw: string;
    try { raw = await this.executor.run({ command, args, cwd: job.cwd, stdin, env: TaskEnvironment.create(), signal: job.signal, compactProgress: true, onProgress, onStdout: (text) => meter.push(text) }); }
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
      if (envelope.is_error || envelope.type === 'turn.failed' || (envelope.status && !NATIVE_SUCCESS_STATUSES.has(envelope.status)))
        throw new Error(`Native agent failed: ${CompactProgress.record(envelope).join('\n') || CompactProgress.diagnostics(`Error: ${envelope.result ?? envelope.response ?? 'CLI failure'}`)}`);
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
