import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeAgentRunner } from './native-runner.js';
import { ModelApiRunner } from './model-api-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob, type RunnerId } from '../../../../shared/automation/contracts.js';

test('native adapters preserve model, prompt and native result/error envelopes', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-adapters-'));
  class FixtureExecutor extends ProcessExecutor {
    public request?: ProcessRequest;
    public output = '';
    public override async run(request: ProcessRequest): Promise<string> { this.request = request; return this.output; }
  }
  const executor = new FixtureExecutor();
  try {
    const envelopes: [RunnerId, string][] = [
      ['codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex-answer' } })],
      ['claude-code', JSON.stringify({ result: 'claude-answer', session_id: 's' })],
      ['opencode', JSON.stringify({ type: 'text', part: { text: 'opencode-answer' } })],
      ['antigravity', JSON.stringify({ status: 'SUCCESS', response: 'agy-answer' }, null, 2)],
      ['deepseek-harness', '{"verdict":"pass","summary":"headless-answer"}'],
    ];
    for (const [runner, output] of envelopes) {
      executor.output = output;
      const job: AgentJob = { runId: 'test', cwd, prompt: 'Инструкции задачи', signal: AbortSignal.timeout(5000),
        profile: { id: 'dev', role: 'developer', runner, connectionId: 'native', model: 'chosen-model', nativeProfile: 'configured-headless', instructions: '' },
        connection: { id: 'native', label: 'Native', kind: 'native', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS) };
      const result = await new NativeAgentRunner(runner, executor).run(job, () => undefined);
      assert.ok(result.text.includes('answer'));
      assert.ok(executor.request!.args.includes(runner === 'deepseek-harness' ? 'configured-headless' : 'chosen-model'));
      assert.equal(executor.request!.env?.SAT_WORKSPACE, undefined);
      assert.equal(executor.request!.env?.SAT_DB_PATH, undefined);
      if (runner === 'codex' || runner === 'claude-code') assert.equal(executor.request!.stdin, job.prompt);
      if (runner === 'codex') {
        const args = executor.request!.args.join(' ');
        assert.match(args, /enabled_tools=.*tracker_get_task/);
        assert.match(args, /default_tools_approval_mode="auto"/);
        assert.equal(args.includes('danger-full-access'), false);
        assert.equal(args.includes('bypass'), false);
      }
    }
    executor.output = '{"is_error":true,"result":"auth failed"}';
    await assert.rejects(new NativeAgentRunner('claude-code', executor).run({ cwd, prompt: 'Test error envelope', profile: { model: 'm' }, signal: AbortSignal.timeout(5000) } as AgentJob, () => undefined), /failed/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Ollama-compatible loop exposes bounded tools and returns the final verdict', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-model-'));
  let turn = 0;
  try {
    await writeFile(path.join(cwd, 'source.txt'), 'existing content', 'utf8');
    const request: typeof fetch = async (url, options) => {
      assert.equal(url, 'http://localhost:11434/v1/chat/completions');
      const payload = JSON.parse(String(options?.body));
      assert.equal(payload.model, 'local-model');
      if (turn++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"path":"source.txt"}' } }] } }] });
      assert.ok(JSON.stringify(payload.messages).includes('existing content'));
      return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"pass","summary":"inspected source"}' } }] });
    };
    const result = await new ModelApiRunner(new ProcessExecutor(), request).run({ runId: 'test', cwd, prompt: 'Review the file.', signal: AbortSignal.timeout(5000),
      profile: { id: 'review', role: 'reviewer', runner: 'model-api', connectionId: 'local', model: 'local-model', instructions: '' },
      connection: { id: 'local', label: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS) }, () => undefined);
    assert.equal(JSON.parse(result.text).verdict, 'pass');
    assert.equal(turn, 2);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
