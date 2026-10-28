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
  assert.equal(stream.usage?.inputTokens, 120); assert.equal(stream.usage?.reportedRequests, 2);
  stream.record({ event: 'result', result: { status: 'SUCCESS', response: '', structured_output: { verdict: 'pass', summary: 'plan' },
    usage: { input_tokens: 125, output_tokens: 20, cache_read_tokens: 10, thinking_tokens: 4 } } });
  assert.equal(stream.usage?.inputTokens, 125); assert.equal(samples.at(-1)?.terminal, true);
  assert.ok(samples.slice(0, -1).every(sample => !sample.terminal));
  assert.equal(logs.filter(line => line.includes('Antigravity tool')).length, 1);
  assert.doesNotMatch(logs.join(''), /PRIVATE_/);
  assert.equal(JSON.parse(stream.result!).structured_output.verdict, 'pass');
  const partial = new AntigravityStream(() => {}); partial.record(step(1, 5)); partial.record({ event: 'result', result: { status: 'ERROR' } });
  assert.equal(partial.usage?.missingRequests, 1);
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
