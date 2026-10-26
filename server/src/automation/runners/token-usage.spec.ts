import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeUsageStream, UsageParser } from './usage-parser.js';
import { TokenMeter, UsageSource } from '../../../../shared/automation/token-usage.js';
import { NativeAgentRunner } from './native-runner.js';
import { ModelApiRunner } from './model-api-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { AutomationTool } from '../../../../shared/automation/protocol.js';

const sample = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, reportedRequests: 1, missingRequests: 0, source: UsageSource.Codex };
const codex = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } });
const job = (cwd: string): AgentJob => ({ runId: 'fixture', cwd, prompt: 'Inspect fixture.', signal: AbortSignal.timeout(10000),
  profile: { id: 'dev', role: 'developer', runner: 'codex', connectionId: 'native', model: 'fixture', instructions: '' },
  connection: { id: 'native', kind: 'native', label: 'Fixture', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS) });

test('token usage normalizes cache semantics, rejects invalid counters and never invents usage', () => {
  assert.deepEqual(UsageParser.native('codex', JSON.parse(codex)), { ...sample, cacheWriteInputTokens: undefined, reasoningTokens: undefined });
  const claude = UsageParser.native('claude-code', { type: 'result', usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 90, cache_creation_input_tokens: 20 } })!;
  assert.equal(claude.inputTokens, 120); assert.equal(claude.outputTokens, 8);
  assert.equal(UsageParser.compatible({ prompt_tokens: 100, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } })!.outputTokens, 30);
  assert.equal(UsageParser.compatible({ prompt_tokens: -1, completion_tokens: 1 }), undefined);
  assert.equal(UsageParser.compatible({ prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } }), undefined);
  assert.equal(UsageParser.compatible({ prompt_tokens: '10', completion_tokens: 1 }), undefined);
  assert.equal(UsageParser.native('custom', JSON.parse(codex)), undefined);
  assert.equal(UsageParser.native('opencode', JSON.parse(codex)), undefined);
  assert.equal(TokenMeter.label(TokenMeter.summary()), 'Токены: нет данных');
});

test('stdout usage survives chunks and log-tail truncation, including a failing process', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-usage-native-'));
  class Fixture extends ProcessExecutor {
    public fail = false;
    public override async run(request: ProcessRequest): Promise<string> {
      const output = `${codex}\n${'noise'.repeat(100000)}\n${codex}`;
      for (let i = 0; i < output.length; i += 37) request.onStdout?.(output.slice(i, i + 37));
      request.onProgress?.(codex); // stderr/progress is not another token report.
      if (this.fail) throw new Error('fixture exit 1');
      return '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}';
    }
  }
  try {
    const executor = new Fixture(); const runner = new NativeAgentRunner('codex', executor);
    const request = job(root); let tokens = 0; request.onUsage = (u) => { tokens = u.inputTokens + u.outputTokens; };
    const result = await runner.run(request, () => undefined);
    assert.equal(result.usage!.inputTokens, 200); assert.equal(tokens, 240); assert.equal(result.text, 'done');
    executor.fail = true; tokens = 0;
    await assert.rejects(runner.run(request, () => undefined), /fixture exit 1/); assert.equal(tokens, 240);
    const stream = new NativeUsageStream('codex'); stream.push(codex.slice(0, 9)); stream.push(codex.slice(9)); stream.finish();
    assert.equal(stream.usage!.inputTokens, 100);
    stream.push('{"type":"turn.completed"}\n'); stream.finish();
    assert.equal(stream.usage!.missingRequests, 1, 'A completed turn without usage makes the sum partial');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model API sums every tool-loop response and exposes missing or failed later requests', async () => {
  let turn = 0;
  const request: typeof fetch = async () => {
    if (turn++ === 0) return Response.json({ usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } },
      choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{"path":"missing"}' } }] } }] });
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'answer' } }] });
  };
  const j = job(os.tmpdir()); j.profile.runner = 'model-api'; j.connection = { id: 'api', label: 'API', kind: 'openai-compatible', baseUrl: 'http://fixture', supportsImages: false };
  const result = await new ModelApiRunner(new ProcessExecutor(), request).run(j, () => undefined);
  assert.equal(result.usage!.inputTokens, 50); assert.equal(result.usage!.missingRequests, 1);
  turn = 0;
  const complete: typeof fetch = async () => Response.json({ usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [{ message: { role: 'assistant', content: 'zero' } }] });
  assert.equal((await new ModelApiRunner(new ProcessExecutor(), complete).run(j, () => undefined)).usage!.inputTokens, 0);
  let observed = 0;
  j.onUsage = (u) => { observed = u.inputTokens; };
  const failure: typeof fetch = async (...args) => turn ? new Response('failure', { status: 500 }) : request(...args);
  await assert.rejects(new ModelApiRunner(new ProcessExecutor(), failure).run(j, () => undefined), /HTTP 500/); assert.equal(observed, 50);
});

test('usage checkpoints are lease-protected, idempotent, persistent and retained across resume but not restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-usage-store-'));
  const config = { appRoot: root, dbPath: path.join(root, 'tracker.db') };
  let app = createContainer({ config, logger: new SilentLogger() });
  try {
    const s = app.automationService; const settings = structuredClone(DEFAULT_AUTOMATION_SETTINGS);
    settings.repositoryPath = '/fixture'; settings.connections = [{ id: 'native', kind: 'native', label: 'Fixture', supportsImages: false }];
    const roles = ['analyst', 'developer', 'tester', 'reviewer'] as const;
    settings.agents = roles.map((role) => ({ id: role, role, runner: 'codex', model: 'fixture', connectionId: 'native', instructions: '' }));
    settings.pipeline = [...roles]; settings.checks = [{ command: 'npm', args: ['test'] }]; s.configure(settings);
    const task = app.taskService.createTask({ title: 'Token fixture' }); const run = s.enqueue(task.id); const owned = s.claim('worker')!; const token = owned.leaseToken!;
    const tools = new TrackerToolRegistry(app);
    const begin = await tools.call(AutomationTool.BeginStage, { id: run.id, leaseToken: token });
    const attemptId = JSON.parse(begin.content[0].type === 'text' ? begin.content[0].text : '{}').attemptId as string;
    assert.ok(attemptId);
    assert.throws(() => s.usage(run.id, 'wrong', attemptId, sample, false), /lease/);
    assert.throws(() => s.usage(run.id, token, 'unknown', sample, false), /Unknown/);
    assert.throws(() => s.usage(run.id, token, attemptId, { ...sample, inputTokens: -1 }, false), /Invalid/);
    const update = { id: run.id, leaseToken: token, attemptId, usage: sample, finished: false };
    assert.ok(!(await tools.call(AutomationTool.Usage, update)).isError);
    await tools.call(AutomationTool.Usage, update);
    s.usage(run.id, token, attemptId, { ...sample, inputTokens: 80 }, false);
    assert.equal(s.queue().items[0].tokenUsage!.totalTokens, 120);
    s.fail(run.id, token, 'fixture failure'); s.resume(run.id);
    const resumed = s.claim('worker')!; const next = s.beginStage(run.id, resumed.leaseToken!);
    s.usage(run.id, resumed.leaseToken!, next, sample, true);
    assert.equal(s.queue().items[0].tokenUsage!.totalTokens, 240);
    assert.equal(s.queue().items[0].tokenUsage!.partial, true);
    s.fail(run.id, resumed.leaseToken!, 'stop');
    const restarted = s.restart(run.id); assert.equal(TokenMeter.summary(restarted.usageAttempts).measuredAttempts, 0);
    app.close(); app = createContainer({ config, logger: new SilentLogger() });
    const attempts = app.automationService.detail(run.id).run.usageAttempts!;
    assert.equal(attempts.length, 2); assert.equal(TokenMeter.summary(attempts).totalTokens, 240);
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});
