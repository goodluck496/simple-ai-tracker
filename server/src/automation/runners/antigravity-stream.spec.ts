import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AntigravityStream } from './antigravity-stream.js';
import { NativeAgentRunner } from './native-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

test('Antigravity stream emits safe tool metadata and idempotent partial usage replaced by terminal totals', () => {
  const logs: string[] = []; const samples: { input: number; terminal: boolean }[] = [];
  const stream = new AntigravityStream(line => logs.push(line), (usage, state) => samples.push({ input: usage.inputTokens, terminal: state.terminal }));
  stream.record({ event: 'init', init: { permission_mode: 'always-proceed', tools: ['PRIVATE_SCHEMA_BODY'] } });
  const tool = { event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'DONE',
    tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'node -e "PRIVATE_SCRIPT_BODY"' }, output: 'PRIVATE_FILE_BODY' } } };
  stream.record(tool); stream.record(tool);
  const step = (index: number, input: number) => ({ event: 'step_update', step_update: { step_index: index, step_type: 'agent_response', state: 'DONE',
    text_delta: 'PRIVATE_REASONING', usage: { input_tokens: input, output_tokens: 10, cache_read_tokens: 5, thinking_tokens: 2 } } });
  stream.record(step(2, 100)); stream.record(step(2, 100)); stream.record(step(3, 20));
  assert.equal(stream.usage?.inputTokens, 130); assert.equal(stream.usage?.reportedRequests, 2);
  stream.record({ event: 'result', result: { status: 'SUCCESS', response: '', structured_output: { verdict: 'pass', summary: 'plan' },
    usage: { input_tokens: 125, output_tokens: 20, cache_read_tokens: 10, thinking_tokens: 4 } } });
  assert.equal(stream.usage?.inputTokens, 135); assert.equal(samples.at(-1)?.terminal, true);
  assert.ok(samples.slice(0, -1).every(sample => !sample.terminal));
  assert.equal(logs.filter(line => line.includes('Antigravity tool')).length, 1);
  assert.doesNotMatch(logs.join(''), /PRIVATE_/);
  assert.equal(JSON.parse(stream.result!).structured_output.verdict, 'pass');
  const partial = new AntigravityStream(() => {}); partial.record(step(1, 5)); partial.record({ event: 'result', result: { status: 'ERROR' } });
  assert.equal(partial.usage?.missingRequests, 1);
});

test('resumed Antigravity subtracts the already-accounted session usage and includes cached input once', () => {
  const baseline = { inputTokens: 30384, outputTokens: 4, cachedInputTokens: 0, reasoningTokens: 0,
    reportedRequests: 1, missingRequests: 0, source: 'antigravity-json' as const };
  const stream = new AntigravityStream(() => {}, undefined, undefined, undefined, baseline);
  stream.record({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'agent_response',
    usage: { input_tokens: 278, output_tokens: 4, cache_read_tokens: 30214, thinking_tokens: 0 } } });
  assert.equal(stream.usage!.inputTokens, 30492, 'Partial events belong only to the current invocation');
  stream.record({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 30662, output_tokens: 8, cache_read_tokens: 30214, thinking_tokens: 0 } } });
  assert.equal(stream.usage!.inputTokens, 30492);
  assert.equal(stream.usage!.outputTokens, 4);
  assert.equal(stream.usage!.cachedInputTokens, 30214);
  assert.equal(baseline.inputTokens + stream.usage!.inputTokens, 60876, 'The cumulative conversation is counted once');
  const observedBaseline = { ...baseline, inputTokens: 41344, outputTokens: 1692, reasoningTokens: 1189, reportedRequests: 4 };
  const replay = new AntigravityStream(() => {}, undefined, undefined, undefined, observedBaseline);
  replay.record({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 131335, output_tokens: 3804, cache_read_tokens: 0, thinking_tokens: 2627 } } });
  assert.equal(replay.usage!.inputTokens, 89991, 'Observed live resume metadata is not billed twice');
  assert.equal(replay.usage!.outputTokens, 2112);
});

test('native runner consumes streamed terminal result even when retained stdout tail is not JSON', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-agy-stream-'));
  class Fixture extends ProcessExecutor {
    public override async run(request: ProcessRequest) {
      assert.equal(request.args[request.args.indexOf('--output-format') + 1], 'stream-json');
      for (const record of [
        { event: 'init', init: { permission_mode: 'always-proceed' } },
        { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'hidden',
          usage: { input_tokens: 10, output_tokens: 2 } } },
        { event: 'result', result: { status: 'SUCCESS', structured_output: { verdict: 'pass', summary: 'Plan', plan: '# Real result' },
          usage: { input_tokens: 12, output_tokens: 3 } } },
      ]) { const line = JSON.stringify(record) + '\n'; request.onStdout?.(line.slice(0, 8)); request.onStdout?.(line.slice(8)); }
      return 'truncated retained stdout';
    }
  }
  try {
    const samples: boolean[] = [];
    const job: AgentJob = { runId: 'fixture', cwd, prompt: 'fixture',
      profile: { id: 'analyst', role: 'analyst', runner: 'antigravity', model: 'fixture', connectionId: 'n', instructions: '' },
      connection: { id: 'n', label: 'Native', kind: 'native', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS),
      signal: AbortSignal.timeout(5000), onUsage: (_, state) => { if (state) samples.push(state.terminal); } };
    const result = await new NativeAgentRunner('antigravity', new Fixture(), { async verify() {} }).run(job, () => {});
    assert.equal(JSON.parse(result.text).plan, '# Real result');
    assert.equal(result.usage?.inputTokens, 12); assert.deepEqual(samples, [false, true]);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('native Antigravity resumes only explicit conversation and stops on observed tools without retry', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-agy-bounds-'));
  let calls = 0; let mode = 'pass'; const sessions: string[] = [];
  class Fixture extends ProcessExecutor {
    public override async run(request: ProcessRequest) {
      calls++;
      assert.equal(request.args[request.args.indexOf('--conversation') + 1], 'session-1');
      assert.equal(request.args.includes('--continue'), false);
      const send = (value: unknown) => request.onStdout?.(JSON.stringify(value) + '\n');
      send({ event: 'init', conversation_id: mode === 'wrong' ? 'session-2' : 'session-1', init: { permission_mode: 'always-proceed' } });
      for (const index of [1, 1, 2, 2, ...(mode === 'limit' ? [3] : [])])
        send({ event: 'step_update', step_update: { step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file' } });
      if (mode !== 'pass') { assert.equal(request.signal.aborted, true); request.signal.throwIfAborted(); }
      send({ event: 'result', result: { status: 'SUCCESS', structured_output: { verdict: 'pass', summary: 'Completed' } } });
      return '';
    }
  }
  try {
    const job: AgentJob = { runId: 'fixture', cwd, prompt: 'fixture', sessionId: 'session-1', maxToolCalls: 2,
      profile: { id: 'analyst', role: 'analyst', runner: 'antigravity', model: 'fixture', connectionId: 'n', instructions: '' },
      connection: { id: 'n', label: 'Native', kind: 'native', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS),
      signal: AbortSignal.timeout(5000), onSession: id => sessions.push(id) };
    const runner = new NativeAgentRunner('antigravity', new Fixture(), { async verify() {} });
    assert.equal(JSON.parse((await runner.run(job, () => {})).text).verdict, 'pass');
    assert.deepEqual(sessions, ['session-1']);
    mode = 'limit'; await assert.rejects(runner.run(job, () => {}), /предел 2/);
    mode = 'wrong'; await assert.rejects(runner.run(job, () => {}), /different conversation/);
    assert.equal(calls, 3, 'Exactly one native process per runner invocation');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
