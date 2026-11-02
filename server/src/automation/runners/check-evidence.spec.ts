import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import { ModelApiRunner } from './model-api-runner.js';
import { ProcessExecutor } from './process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../../shared/automation/contracts.js';

test('API gets failing test evidence from stdout even when stderr contains a warning', async () => {
  const logs: string[] = []; let turn = 0;
  const request: typeof fetch = async (_url, options) => {
    const input = JSON.parse(String(options?.body));
    const tool = input.tools.find((t: { function: { name: string } }) => t.function.name === 'run_check').function;
    assert.deepEqual(tool.parameters.properties.index.enum, [0]);
    assert.deepEqual(tool.parameters.required, ['index']);
    assert.match(tool.description, /0:/);
    if (turn++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'check', function: { name: 'run_check', arguments: '{"index":0}' } }],
    } }] });
    const result = JSON.parse(input.messages.at(-1).content);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /Campfire fuel addition/);
    assert.match(result.stdout, /expected: 25/); assert.match(result.stdout, /actual: 10/);
    assert.match(result.stderr, /ExperimentalWarning/);
    assert.equal(result.outputLimited, false);
    return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"blocked","summary":"Fuel assertion failed: expected 25, actual 10"}' } }] });
  };
  const result = await new ModelApiRunner(new ProcessExecutor(), request).run({ runId: 'evidence', cwd: os.tmpdir(), prompt: 'Check',
    profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'api', model: 'fixture', instructions: '' },
    connection: { id: 'api', label: 'API', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
    settings: { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), checks: [{ command: process.execPath, args: ['-e', "console.log('not ok 1 - Campfire fuel addition\\nexpected: 25\\nactual: 10\\nPRIVATE_TEST_BODY');console.error('ExperimentalWarning: SQLite');process.exit(1)"] }] },
    signal: AbortSignal.timeout(10000),
  }, text => { logs.push(text); });
  assert.equal(JSON.parse(result.text).verdict, 'blocked');
  assert.doesNotMatch(logs.join(''), /PRIVATE_TEST_BODY/);
});

test('API tells the model which check indices exist after an invalid request', async () => {
  let turn = 0;
  const request: typeof fetch = async (_url, options) => {
    if (turn++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'bad-check', function: { name: 'run_check', arguments: '{"index":3}' } }],
    } }] });
    const input = JSON.parse(String(options?.body));
    assert.match(JSON.parse(input.messages.at(-1).content).error, /Available zero-based indices: 0: npm test/);
    return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"blocked","summary":"Use index 0"}' } }] });
  };
  await new ModelApiRunner(new ProcessExecutor(), request).run({ runId: 'indices', cwd: os.tmpdir(), prompt: '',
    profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'api', model: 'fixture', instructions: '' },
    connection: { id: 'api', label: 'API', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
    settings: { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), checks: [{ command: 'npm', args: ['test'] }] }, signal: AbortSignal.timeout(5000),
  }, () => {});
});
