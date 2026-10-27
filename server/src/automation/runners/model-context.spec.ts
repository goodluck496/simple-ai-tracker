import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelApiRunner } from './model-api-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

test('API agents read bounded ranges, apply exact patches and do not echo tool results into progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-model-context-')); const originalFetch = globalThis.fetch;
  const source = 'const value = 2; // PRIVATE_SOURCE_SENTINEL'; const replacement = 'const value = "$&";';
  const steps = [
    ['read_file', { path: 'source.ts', startLine: 1, endLine: 41 }],
    ['read_file', { path: 'source.ts', startLine: 2, endLine: 2 }],
    ['edit_file', { path: 'source.ts', oldText: source, newText: replacement }],
    ['write_file', { path: 'source.ts', content: 'OVERWRITE' }],
    ['explore_code', { symbol: 'Example.method' }],
  ] as const;
  const results: unknown[] = []; const logs: string[] = []; let turn = 0;
  class Fixture extends ProcessExecutor { public override async run(r: ProcessRequest) { assert.equal(r.command, 'codegraph'); assert.ok(r.args.includes('1')); return 'method source'; } }
  try {
    await writeFile(path.join(root, 'source.ts'), '// first\n' + source + '\n// end');
    globalThis.fetch = async (_input, options) => {
      const messages = JSON.parse(String(options?.body)).messages;
      if (messages.at(-1)?.role === 'tool') results.push(JSON.parse(messages.at(-1).content));
      const step = steps[turn++];
      return Response.json({ choices: [{ message: step ? { role: 'assistant', content: null, tool_calls: [{ id: `t${turn}`, function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
        : { role: 'assistant', content: '{"verdict":"pass","summary":"done"}' } }] });
    };
    const job: AgentJob = { runId: 'fixture', cwd: root, prompt: 'Patch source', profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'test', model: 'test', instructions: '' },
      connection: { id: 'test', label: 'fixture', kind: 'openai-compatible', baseUrl: 'http://fixture.invalid', supportsImages: false }, settings: DEFAULT_AUTOMATION_SETTINGS, signal: AbortSignal.timeout(10000) };
    await new ModelApiRunner(new Fixture()).run(job, text => logs.push(text));
    assert.match(JSON.stringify(results[0]), /40 lines/); assert.match(JSON.stringify(results[1]), /PRIVATE_SOURCE_SENTINEL/);
    assert.match(JSON.stringify(results[3]), /Use edit_file/);
    assert.equal(await readFile(path.join(root, 'source.ts'), 'utf8'), '// first\n' + replacement + '\n// end');
    assert.doesNotMatch(logs.join(''), /PRIVATE_SOURCE_SENTINEL|method source|OVERWRITE/);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
