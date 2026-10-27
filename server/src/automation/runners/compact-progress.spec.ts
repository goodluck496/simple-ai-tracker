import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';
import { NativeAgentRunner } from './native-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

test('native source/patch/MCP payloads stay out of progress while structured result and usage survive chunking', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-compact-'));
  const source = 'PRIVATE_SOURCE_SENTINEL'; const output: string[] = [];
  const outcome = JSON.stringify({ verdict: 'pass', summary: 'done', plan: source });
  const raw = [
    { type: 'item.completed', item: { id: '1', type: 'command_execution', aggregated_output: source.repeat(2000), exit_code: 0 } },
    { type: 'item.completed', item: { id: '2', type: 'file_change', changes: [{ path: 'src/a.ts', diff: source }] } },
    { type: 'item.completed', item: { id: '3', type: 'mcp_tool_call', arguments: { source }, result: source } },
    { type: 'item.completed', item: { id: '4', type: 'agent_message', text: outcome } },
    { type: 'turn.completed', usage: { input_tokens: 42, cached_input_tokens: 20, output_tokens: 3 } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n';
  class Fixture extends ProcessExecutor {
    public override async run(request: ProcessRequest) {
      if (request.args[0] === 'mcp') return '[]';
      assert.equal(request.compactProgress, true);
      for (let offset = 0; offset < raw.length; offset += 97) request.onStdout?.(raw.slice(offset, offset + 97));
      return raw;
    }
  }
  try {
    const job: AgentJob = { runId: 'compact', cwd, prompt: 'test', profile: { id: 'dev', role: 'developer', runner: 'codex', connectionId: 'native', model: 'fixture', instructions: '' },
      connection: { id: 'native', label: 'fixture', kind: 'native', supportsImages: false }, settings: DEFAULT_AUTOMATION_SETTINGS, signal: AbortSignal.timeout(10000) };
    const result = await new NativeAgentRunner('codex', new Fixture()).run(job, line => output.push(line));
    assert.equal(result.text, outcome); assert.equal(result.usage?.inputTokens, 42);
    assert.doesNotMatch(output.join(''), /PRIVATE_SOURCE_SENTINEL|aggregated_output|arguments|diff/);
    assert.match(output.join(''), /src\/a.ts/); assert.match(output.join(''), /exit 0/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('compact subprocess progress retains only result or relevant failure trace', async () => {
  const executor = new ProcessExecutor(); const lines: string[] = [];
  const run = (script: string) => executor.run({ command: process.execPath, args: ['-e', script], cwd: os.tmpdir(), signal: AbortSignal.timeout(10000), compactProgress: true, onProgress: text => lines.push(text) });
  assert.equal(await run("process.stdout.write('PRIVATE_SOURCE_SENTINEL')"), 'PRIVATE_SOURCE_SENTINEL');
  assert.doesNotMatch(lines.join(''), /PRIVATE_SOURCE_SENTINEL/); assert.match(lines.join(''), /exit 0/);
  await assert.rejects(run("console.log('PRIVATE_SOURCE_SENTINEL'); console.error('TypeError: fixture failure\\n    at fixture (a.ts:3:1)'); process.exit(1)"), /fixture failure/);
  assert.doesNotMatch(lines.join(''), /PRIVATE_SOURCE_SENTINEL/); assert.match(lines.join(''), /at fixture/);
  assert.deepEqual(CompactProgress.record({ type: 'item.updated', item: { text: 'PRIVATE_SOURCE_SENTINEL' } }), []);
});

test('compact progress identifies commands and MCP tools without copying payloads', () => {
  assert.deepEqual(CompactProgress.record({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'codegraph', tool: 'codegraph_explore', arguments: { code: 'PRIVATE_SOURCE_SENTINEL' } } }), ['MCP codegraph/codegraph_explore: вызов.']);
  assert.deepEqual(CompactProgress.record({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'simple-ai-tracker', tool: 'tracker_get_task', status: 'completed', result: 'PRIVATE_SOURCE_SENTINEL' } }), ['MCP simple-ai-tracker/tracker_get_task: завершён.']);
  assert.match(CompactProgress.record({ type: 'item.completed', item: { type: 'command_execution', command: 'npm.cmd test', exit_code: 0 } })[0], /npm.cmd test.*exit 0/);
  assert.match(CompactProgress.command('powershell.exe -Command "Get-Content src/a.ts"'), /Get-Content src\/a.ts/);
  assert.doesNotMatch(CompactProgress.command('node', ['-e', 'PRIVATE_SOURCE_SENTINEL']), /PRIVATE_SOURCE_SENTINEL/);
  assert.doesNotMatch(CompactProgress.command('powershell.exe -Command "Set-Content a.ts PRIVATE_SOURCE_SENTINEL"'), /PRIVATE_SOURCE_SENTINEL/);
  assert.match(CompactProgress.record({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'codegraph', tool: 'codegraph_explore', status: 'failed' } })[0], /ошибка/);
  assert.deepEqual(CompactProgress.success('PRIVATE_SOURCE_SENTINEL\n✅ All 17 tests passed successfully\n'), ['Тесты: 17 пройдено.']);
});
