import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeAgentRunner } from './native-runner.js';
import { ModelApiRunner } from './model-api-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import { NativeExecutable } from './native-executable.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob, type RunnerId } from '../../../../shared/automation/contracts.js';

test('native adapters preserve model, prompt and native result/error envelopes', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-adapters-'));
  class FixtureExecutor extends ProcessExecutor {
    public request?: ProcessRequest;
    public output = '';
    public override async run(request: ProcessRequest): Promise<string> {
      if (request.command === 'codex' && request.args[0] === 'mcp') return JSON.stringify([{ name: 'simple-ai-tracker' },
        { name: 'blender', transport: { type: 'stdio', command: 'fixture-desktop-bridge' } }, { name: 'codegraph' },
        { name: 'http_fixture', transport: { type: 'streamable_http', url: 'https://example.invalid/mcp' } },
        { name: 'disabled_virtual', enabled: false }]);
      this.request = request; return this.output;
    }
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
        const argv = executor.request!.args;
        const schemaPath = argv[argv.indexOf('--output-schema') + 1];
        assert.equal(schemaPath, path.join(cwd, '.sat', 'outcome-schema.json'));
        const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
        assert.ok(schema.required.includes('commitMessage'));
        assert.equal(schema.properties.commitMessage.type, 'string');
        assert.equal(schema.additionalProperties, false);
        const args = executor.request!.args.join(' ');
        assert.ok(argv.includes('tool_output_token_limit=800'));
        assert.match(args, /enabled_tools=.*tracker_get_task/);
        assert.match(args, /default_tools_approval_mode="auto"/);
        assert.match(args, /mcp_servers.blender.enabled=false/);
        assert.ok(argv.includes('mcp_servers.blender.command="fixture-desktop-bridge"'));
        assert.ok(argv.includes('mcp_servers.http_fixture.url="https://example.invalid/mcp"'));
        assert.ok(argv.includes('mcp_servers.http_fixture.enabled=false'));
        assert.match(args, /mcp_servers.simple-ai-tracker.enabled=true/);
        assert.equal(argv.includes('mcp_servers.simple-ai-tracker.enabled=false'), false);
        assert.ok(argv.some(arg => arg.startsWith('mcp_servers.simple-ai-tracker.command=')));
        assert.ok(argv.some(arg => arg.startsWith('mcp_servers.simple-ai-tracker.args=')));
        assert.ok(argv.some(arg => arg.startsWith('mcp_servers.simple-ai-tracker.env=') && arg.includes('SAT_WORKSPACE')));
        assert.match(args, /mcp_servers.codegraph.enabled=false/);
        assert.equal(args.includes('mcp_servers.disabled_virtual'), false);
        assert.equal(args.includes('danger-full-access'), false);
        assert.equal(args.includes('bypass'), false);
      }
    }
    await mkdir(path.join(cwd, '.codegraph'));
    executor.output = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'indexed-answer' } });
    await new NativeAgentRunner('codex', executor).run({ cwd, prompt: 'Indexed repository', profile: { model: 'm' }, signal: AbortSignal.timeout(5000) } as AgentJob, () => undefined);
    assert.equal(executor.request!.args.includes('mcp_servers.codegraph.enabled=false'), false);
    assert.ok(executor.request!.args.includes(`mcp_servers.codegraph.args=${JSON.stringify(NativeExecutable.codegraphMcp(cwd).args)}`));
    assert.ok(executor.request!.args.includes('mcp_servers.codegraph.enabled_tools=["codegraph_explore"]'));
    assert.ok(executor.request!.args.includes('mcp_servers.blender.enabled=false'));
    await new NativeAgentRunner('codex', executor).run({ cwd, prompt: 'Project MCP', profile: { model: 'm' },
      projectMcp: [{ name: 'blender', command: 'project-bridge', args: ['--path', cwd], envVars: ['PROJECT_TOKEN'], tools: ['lookup'] }],
      signal: AbortSignal.timeout(5000) } as AgentJob, () => undefined);
    assert.ok(executor.request!.args.includes('mcp_servers.blender.command="project-bridge"'));
    assert.ok(executor.request!.args.includes('mcp_servers.blender.enabled_tools=["lookup"]'));
    assert.ok(executor.request!.args.includes('mcp_servers.blender.env_vars=["PROJECT_TOKEN"]'));
    assert.equal(executor.request!.args.includes('mcp_servers.blender.enabled=false'), false);
    executor.output = '{"is_error":true,"result":"auth failed"}';
    await assert.rejects(new NativeAgentRunner('claude-code', executor).run({ cwd, prompt: 'Test error envelope', profile: { model: 'm' }, signal: AbortSignal.timeout(5000) } as AgentJob, () => undefined), /failed/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('native operation threshold warns once without interrupting useful work or external cancellation', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-tool-limit-'));
  class Fixture extends ProcessExecutor {
    public override async run(request: ProcessRequest): Promise<string> {
      if (request.args[0] === 'mcp') return '[]';
      for (const [id, type] of [['one', 'item.started'], ['one', 'item.completed'], ['two', 'item.started'], ['three', 'item.completed']]) {
        request.onStdout?.(JSON.stringify({ type, item: { id, type: 'command_execution' } }) + '\n');
      }
      request.signal.throwIfAborted();
      return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'completed after threshold' } });
    }
  }
  try {
    const progress: string[] = [];
    const runner = new NativeAgentRunner('codex', new Fixture());
    const job = { cwd, prompt: 'A bounded stage', maxToolCalls: 1,
      profile: { model: 'fixture' }, signal: AbortSignal.timeout(5000) } as AgentJob;
    const result = await runner.run(job, text => progress.push(text));
    assert.equal(result.text, 'completed after threshold');
    assert.equal(progress.filter(text => text.includes('Предупреждение:')).length, 1);
    await assert.rejects(runner.run({ ...job, signal: AbortSignal.abort(new Error('user cancelled')) }, () => undefined), /user cancelled/);
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
