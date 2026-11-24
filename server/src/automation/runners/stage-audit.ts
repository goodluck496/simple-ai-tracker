import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRole, ProviderKind, type AgentJob, type AutomationSettings, type ModelConnection } from '../../../../shared/automation/contracts.js';
import { stageAuditRunner } from '../../../../shared/automation/stage-audit.js';
import { ExecutionScope } from './execution-scope.js';
import { NativeAgentRunner } from './native-runner.js';
import type { TokenUsage } from '../../../../shared/automation/token-usage.js';
import { UsageParser } from './usage-parser.js';

type AuditProfile = NonNullable<AutomationSettings['auditAgent']>;
const AUDIT_INSTRUCTIONS = 'You audit AI coding stages. Return only JSON {"findings":[{"signal":"repeatedReads","suggestion":"one concrete action in Russian"}]}. Use only signal keys present in the supplied signals and with nonzero values. Select at most three, in priority order. repeatedChecks is a possible repeat, not proof of unchanged workspace. inputGrowth is peak minus first input tokens, not a savings estimate. Use [] if no action is warranted.';

/** Records stage metrics and optionally requests a background assessment. */
export class StageAudit {
  private static pending = 0;
  private static queue = Promise.resolve();
  private readonly started = performance.now();
  private readonly seen = new Set<string>();
  private readonly checked = new Set<unknown>();
  private readonly tools: Record<string, { calls: number; bytes: number; repeated: number }> = Object.create(null);
  private requests = 0;
  private firstInputTokens?: number;
  private peakInputTokens?: number;
  private verdict?: string;

  public constructor(private readonly job: AgentJob, private readonly directory: string) {}

  public request(): void { this.requests++; }

  public sample(usage?: TokenUsage): void {
    if (!usage) return;
    if (this.requests === 1) this.firstInputTokens = usage.inputTokens;
    this.peakInputTokens = Math.max(this.peakInputTokens ?? 0, usage.inputTokens);
  }

  public tool(name: string, args: Record<string, unknown> | undefined, content: string, failed: boolean): void {
    const counts = this.tools[name] ??= { calls: 0, bytes: 0, repeated: 0 };
    counts.calls++;
    counts.bytes += Buffer.byteLength(content);
    if (name === 'write_file' || name === 'edit_file' || name === 'call_project_tool' || name === 'run_check') {
      // These tools can change workspace state even if they report failure.
      this.seen.clear();
    }
    if (name === 'write_file' || name === 'edit_file' || name === 'call_project_tool') this.checked.clear();
    if (name === 'run_check' && Number.isSafeInteger(args?.index)) {
      if (this.checked.has(args?.index)) counts.repeated++;
      this.checked.add(args?.index);
    }
    if (name !== 'read_file' || failed || !args) return;
    const key = createHash('sha256').update(JSON.stringify([args.path, args.startLine, args.endLine, content])).digest('hex');
    if (this.seen.has(key)) counts.repeated++;
    if (this.seen.size < 1024) this.seen.add(key);
  }

  public finish(verdict: string): void { this.verdict = verdict; }

  public save(usage?: TokenUsage): void {
    const attempt = this.job.auditAttempt!;
    if (!/^[a-f0-9-]{36}$/i.test(attempt.id)) return;
    const { handoffBytes, ...identity } = attempt;
    const evidence = { role: this.job.profile.role, verdict: this.verdict ?? 'interrupted', handoffBytes,
      elapsedMs: Math.round(performance.now() - this.started), promptBytes: Buffer.byteLength(this.job.prompt),
      requests: this.requests, firstInputTokens: this.firstInputTokens, peakInputTokens: this.peakInputTokens,
      usage, tools: this.tools };
    const record = { ...identity, runId: this.job.runId, model: this.job.profile.model, at: new Date().toISOString(), evidence };
    const file = path.resolve(this.directory, `${attempt.id}.json`);
    const auditFile = path.resolve(this.directory, `${attempt.id}.audit.json`);
    const write = async (audit?: unknown) => {
      const target = audit === undefined ? file : auditFile;
      await fs.writeFile(target + '.tmp', JSON.stringify(audit ?? record) + '\n', { mode: 0o600 });
      await fs.rename(target + '.tmp', target);
    };
    const config = this.job.settings.auditAgent;
    const connection = this.job.settings.connections.find(entry => entry.id === config?.connectionId);
    const model = config?.model;
    const signals = {
      repeatedReads: evidence.tools.read_file?.repeated ?? 0,
      repeatedChecks: evidence.tools.run_check?.repeated ?? 0,
      inputGrowth: this.firstInputTokens === undefined ? 0 : (this.peakInputTokens ?? 0) - this.firstInputTokens,
    };
    void fs.mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => write()).then(() => {
      if (!config || config.enabled === false || !model || !connection ||
        !Object.values(signals).some(Boolean) || StageAudit.pending >= 8) return;
      StageAudit.pending++;
      StageAudit.queue = StageAudit.queue.then(async () => {
        const started = performance.now();
        try {
          const input = JSON.stringify({ signals, ...evidence, roleInstructions: config.instructions });
          const { raw, usage } = connection.kind === ProviderKind.Native
            ? await this.assessWithCli(config, connection, input)
            : await this.assessWithApi(config, connection, input);
          let result = raw.length <= 6000 ? JSON.parse(raw) : undefined;
          if (typeof result?.summary === 'string') result = JSON.parse(result.summary);
          const findings = result?.findings;
          if (!Array.isArray(findings) || findings.length > 3 || findings.some(item => !item ||
            !Object.hasOwn(signals, item.signal) || !signals[item.signal as keyof typeof signals] ||
            typeof item.suggestion !== 'string' || !item.suggestion.trim() || item.suggestion.length > 500)) throw new Error('Invalid audit response');
          await write({ model, elapsedMs: Math.round(performance.now() - started), usage,
            findings: findings.map(({ signal, suggestion }) => ({ signal, observed: signals[signal as keyof typeof signals], suggestion })) });
        } catch {
          await write({ model, elapsedMs: Math.round(performance.now() - started), failed: true });
        }
      }).catch(() => { console.warn('Stage audit result could not be saved.'); }).finally(() => { StageAudit.pending--; });
    }).catch(() => { console.warn('Stage audit evidence could not be saved.'); });
  }

  private async assessWithApi(config: AuditProfile, connection: ModelConnection, input: string): Promise<{ raw: string; usage?: TokenUsage }> {
    const base = connection.baseUrl?.replace(/\/$/, '');
    if (!base) throw new Error('Audit endpoint missing');
    const url = `${base}${connection.kind === ProviderKind.Ollama && !base.endsWith('/v1') ? '/v1' : ''}/chat/completions`;
    const secret = connection.credentialEnv ? process.env[connection.credentialEnv] : undefined;
    if (connection.credentialEnv && !secret) throw new Error('Audit credential missing');
    const response = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(30000), redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify({ model: config.model, max_tokens: 500, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: AUDIT_INSTRUCTIONS }, { role: 'user', content: input }],
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { choices?: { message?: { content?: unknown } }[]; usage?: unknown };
    const raw = payload.choices?.[0]?.message?.content;
    return { raw: typeof raw === 'string' ? raw : '', usage: UsageParser.compatible(payload.usage) };
  }

  private async assessWithCli(config: AuditProfile, connection: ModelConnection, input: string): Promise<{ raw: string; usage?: TokenUsage }> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-audit-'));
    try {
      const runner = stageAuditRunner(connection);
      const prompt = [
        AUDIT_INSTRUCTIONS,
        'Use only the supplied metrics. Do not use tools or inspect files other than these instructions.',
        'Wrap the findings JSON as a string in the summary field of the required outcome. Use verdict "pass".',
        input,
      ].join('\n\n');
      const result = await ExecutionScope.run({}, () => new NativeAgentRunner(runner).run({
        runId: this.job.runId, cwd, prompt, connection,
        profile: { ...config, runner, role: AgentRole.Doctor },
        settings: { ...this.job.settings, timeoutMinutes: 1 },
        signal: AbortSignal.timeout(30000),
      }, () => {}, { audit: true }));
      return { raw: result.text, usage: result.usage };
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
}
