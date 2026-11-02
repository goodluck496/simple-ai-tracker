import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import { ModelApiRunner } from './model-api-runner.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

const job: AgentJob = { runId: 'format', cwd: os.tmpdir(), prompt: 'Report actual result',
  profile: { id: 'dev', role: 'developer', runner: 'model-api', model: 'fixture', connectionId: 'api', instructions: '' },
  connection: { id: 'api', kind: 'ollama', baseUrl: 'http://fixture', label: 'Fixture', supportsImages: false },
  settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS), signal: AbortSignal.timeout(10000) };

for (const first of ['The task is complete and the check passed.', '']) {
  test(`repairs ${first ? 'prose' : 'empty output'} in the same conversation without reexecuting tools`, async () => {
    let turn = 0;
    const request: typeof fetch = async (_url, options) => {
      const input = JSON.parse(String(options?.body));
      if (turn++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: first }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      assert.equal(input.tools, undefined);
      assert.equal(input.response_format.type, 'json_schema');
      assert.ok(input.messages.some((m: { content: unknown }) => m.content === first));
      assert.match(input.messages.at(-1).content, /do not invent success/);
      return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"blocked","summary":"Actual check failed"}' } }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
    };
    const result = await new ModelApiRunner(undefined, request).run(job, () => {});
    assert.equal(turn, 2); assert.equal(JSON.parse(result.text).verdict, 'blocked');
    assert.equal(result.usage?.inputTokens, 30);
  });
}

test('unusable final output stops after bounded formatting repairs and cannot execute tools', async () => {
  let turns = 0;
  const request: typeof fetch = async () => {
    turns++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Still prose' }, finish_reason: 'stop' }] });
  };
  await assert.rejects(new ModelApiRunner(undefined, request).run(job, () => {}), /formatting failed after two repair attempts/);
  assert.equal(turns, 3);
});

test('format repair falls back when a compatible provider does not implement JSON Schema', async () => {
  let turns = 0;
  const request: typeof fetch = async (_url, options) => {
    const input = JSON.parse(String(options?.body));
    turns++;
    if (turns === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: 'Task completed' } }] });
    assert.equal(input.tools, undefined);
    if (turns === 2) {
      assert.equal(input.response_format.type, 'json_schema');
      return new Response('response_format json_schema is not supported', { status: 400 });
    }
    assert.equal(input.response_format.type, 'json_object');
    return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"pass","summary":"Actual work retained"}' } }] });
  };
  const result = await new ModelApiRunner(undefined, request).run(job, () => {});
  assert.equal(JSON.parse(result.text).verdict, 'pass'); assert.equal(turns, 3);
});

test('structured finish_task ends the stage without a separate free-text answer or formatting roundtrip', async () => {
  let turns = 0;
  const request: typeof fetch = async (_url, options) => {
    turns++;
    const input = JSON.parse(String(options?.body));
    const finish = input.tools.find((tool: { function: { name: string } }) => tool.function.name === 'finish_task');
    assert.ok(finish.function.parameters.required.includes('commitMessage'));
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'finish',
      function: { name: 'finish_task', arguments: JSON.stringify({ verdict: 'blocked', summary: 'Check failed; no pass claimed', commitMessage: '', questions: [], decomposition: [], plan: '' }) },
    }] } }] });
  };
  const result = await new ModelApiRunner(undefined, request).run({ ...job, signal: AbortSignal.timeout(10000) }, () => {});
  assert.equal(turns, 1); assert.equal(JSON.parse(result.text).verdict, 'blocked');
});
