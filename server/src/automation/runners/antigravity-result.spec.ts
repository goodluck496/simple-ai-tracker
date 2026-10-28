import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AntigravityResult } from './antigravity-result.js';
import { NativeAgentRunner } from './native-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import type { AgentJob } from '../../../../shared/automation/contracts.js';
import { AGENT_OUTCOME_SCHEMA } from '../../../../shared/automation/outcome-schema.js';

test('Antigravity structured output is unwrapped; empty/denied/refused results cannot become pass', () => {
  const logs: string[] = [];
  const outcome = { verdict: 'questions', summary: 'Need access', questions: ['Permit code navigation?'] };
  const result = AntigravityResult.parse(JSON.stringify({ status: 'SUCCESS', conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    response: 'SOURCE_BODY_SENTINEL', structured_output: outcome }), '', line => logs.push(line));
  assert.deepEqual(JSON.parse(result.text), outcome);
  assert.equal(logs.join('').includes('SOURCE_BODY_SENTINEL'), false);
  assert.match(logs.join(''), /structured_output=present/);
  const legacy = AntigravityResult.parse(JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ verdict: 'pass', summary: 'Plan', plan: '# Plan' }) }), '', () => {});
  assert.equal(JSON.parse(legacy.text).plan, '# Plan');
  const empty = JSON.stringify({ status: 'SUCCESS', response: '' });
  assert.throws(() => AntigravityResult.parse(empty, 'jetski: no output produced; command permission required; auto-denied SECRET_SENTINEL', () => {}), error => {
    assert.match(String(error), /permissions.allow/); assert.doesNotMatch(String(error), /SECRET_SENTINEL/); return true;
  });
  assert.throws(() => AntigravityResult.parse(empty, 'authentication required', () => {}), /требуется вход/);
  assert.throws(() => AntigravityResult.parse(empty, '', () => {}), /responseChars=0/);
  assert.throws(() => AntigravityResult.parse(JSON.stringify({ status: 'SUCCESS', response: 'I cannot read the repository.' }), '', () => {}), /не вернул verdict/);
  assert.throws(() => AntigravityResult.parse(JSON.stringify({ status: 'ERROR', error: 'model quota exceeded' }), '', () => {}), /quota exceeded/);
  assert.throws(() => AntigravityResult.parse('not json', '', () => {}), /JSON-обёртку/);
});

test('native Antigravity passes schema and worktree; captures stderr even on exit 0 without publishing bodies', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-agy-result-'));
  class Fixture extends ProcessExecutor {
    public request?: ProcessRequest;
    public denied = false;
    public override async run(request: ProcessRequest): Promise<string> {
      this.request = request;
      if (this.denied) { request.onStderr?.('jetski: command permission was auto-denied'); return JSON.stringify({ status: 'SUCCESS', response: '' }); }
      return JSON.stringify({ status: 'SUCCESS', response: 'DO_NOT_LOG_RAW_RESPONSE', structured_output: { verdict: 'pass', summary: 'Fixture plan' } });
    }
  }
  const executor = new Fixture(); const lines: string[] = [];
  const job = { cwd, prompt: 'Fixture instructions', profile: { role: 'analyst', runner: 'antigravity', model: 'fixture' }, signal: AbortSignal.timeout(10000) } as AgentJob;
  try {
    const result = await new NativeAgentRunner('antigravity', executor, { async verify() {} }).run(job, line => lines.push(line));
    assert.equal(JSON.parse(result.text).verdict, 'pass');
    const args = executor.request!.args;
    assert.equal(args[args.indexOf('--add-dir') + 1], cwd);
    assert.deepEqual(JSON.parse(await fs.readFile(args[args.indexOf('--json-schema') + 1], 'utf8')), AGENT_OUTCOME_SCHEMA);
    assert.equal(args.includes('--dangerously-skip-permissions'), true);
    assert.equal(lines.join('').includes('DO_NOT_LOG_RAW_RESPONSE'), false);
    executor.denied = true;
    await assert.rejects(new NativeAgentRunner('antigravity', executor, { async verify() {} }).run(job, () => {}), /permissions.allow/);
    let diagnostic = '';
    const stdout = await new ProcessExecutor().run({ command: process.execPath, args: ['-e', 'process.stderr.write("fixture auto-denied")'], cwd,
      signal: AbortSignal.timeout(5000), onStderr: text => { diagnostic += text; } });
    assert.equal(stdout, ''); assert.equal(diagnostic, 'fixture auto-denied');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
