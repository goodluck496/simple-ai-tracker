import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelApiRunner } from './model-api-runner.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';
import { NativeAgentRunner } from './native-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';

test('trusted API agent can exceed configured calls and internal turn cap, normal mode remains bounded', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-trusted-model-'));
  try {
    let turn = 0;
    const request: typeof fetch = async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'save_progress'));
      assert.ok(!body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'edit_file'), 'Tester cannot edit sources');
      const message = ++turn <= 42 ? { role: 'assistant', content: null, tool_calls: [{ id: String(turn), type: 'function', function: { name: 'list_files', arguments: '{}' } }] }
        : { role: 'assistant', content: '{"verdict":"pass","summary":"Checked"}' };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    };
    const job: AgentJob = { runId: 'fixture', cwd, prompt: 'test', signal: AbortSignal.timeout(20000), maxToolCalls: 1, trustedExecution: true,
      profile: { id: 'tester', role: 'tester', runner: 'model-api', connectionId: 'local', model: 'fixture', instructions: '' },
      connection: { id: 'local', label: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS) };
    assert.equal(JSON.parse((await new ModelApiRunner(undefined, request).run(job, () => {})).text).verdict, 'pass');
    assert.equal(turn, 43);
    turn = 0;
    await assert.rejects(new ModelApiRunner(undefined, request).run({ ...job, trustedExecution: false }, () => {}), /tool-call limit/);
    await assert.rejects(new ModelApiRunner(undefined, request).run({ ...job, signal: AbortSignal.abort(new Error('manual stop')) }, () => {}), /manual stop/);
    class Fixture extends ProcessExecutor {
      public override async run(input: ProcessRequest) {
        assert.equal(input.args[input.args.indexOf('--print-timeout') + 1], '0');
        for (let index = 0; index < 5; index++) input.onStdout?.(JSON.stringify({ event: 'step_update', step_update: { step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file' } }) + '\n');
        assert.equal(input.signal.aborted, false);
        return JSON.stringify({ status: 'SUCCESS', structured_output: { verdict: 'pass', summary: 'Finished' } });
      }
    }
    assert.equal(JSON.parse((await new NativeAgentRunner('antigravity', new Fixture(), { async verify() {} }).run(job, () => {})).text).verdict, 'pass');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
