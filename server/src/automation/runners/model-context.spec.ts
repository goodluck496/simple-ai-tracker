import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelApiRunner } from './model-api-runner.js';
import { ProcessExecutor, type ProcessRequest } from './process-executor.js';
import { AutomationSettingsValidator } from '../settings.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

test('stage audit saves numeric evidence and calls the local auditor outside the agent request loop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-stage-audit-'));
  const originalFetch = globalThis.fetch;
  const previousDirectory = process.env.SAT_STAGE_AUDIT_DIR;
  const id = randomUUID();
  const directory = path.join(root, 'audit');
  const sentinel = 'PRIVATE_SOURCE_SENTINEL';
  let requests = 0;
  let auditInput: unknown;
  let releaseAudit!: () => void;
  const auditGate = new Promise<void>(resolve => { releaseAudit = resolve; });
  try {
    process.env.SAT_STAGE_AUDIT_DIR = directory;
    await writeFile(path.join(root, 'source.ts'), sentinel);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://audit-fixture.invalid:12600/v1/chat/completions');
      auditInput = JSON.parse(String(options?.body));
      await auditGate;
      return Response.json({ choices: [{ message: { content: '{"findings":[{"signal":"repeatedReads","suggestion":"Повторно используйте ранее прочитанный диапазон."}]}' } }] });
    };
    const request: typeof fetch = async () => {
      requests++;
      const message = requests < 3 ? { tool_calls: [{ id: String(requests), function: {
        name: 'read_file', arguments: '{"path":"source.ts","startLine":1,"endLine":1}',
      } }] } : { content: '{"verdict":"pass","summary":"done"}' };
      return Response.json({ choices: [{ message }], usage: { prompt_tokens: requests * 20, completion_tokens: 4 } });
    };
    const job: AgentJob = { runId: 'fixture', cwd: root, prompt: sentinel,
      auditAttempt: { id, workspace: 'fixture', taskId: 'T-1', stage: 0, revision: 0, handoffBytes: 10 },
      profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'test', model: 'test', instructions: '' },
      connection: { id: 'test', label: 'fixture', kind: 'openai-compatible', baseUrl: 'http://fixture.invalid', supportsImages: false },
      settings: new AutomationSettingsValidator().validate({ ...DEFAULT_AUTOMATION_SETTINGS,
        connections: [{ id: 'auditor', label: 'Local', kind: 'ollama', baseUrl: 'http://audit-fixture.invalid:12600', supportsImages: false }],
        auditAgent: { id: 'stage-audit', role: 'stage-audit', runner: 'model-api', connectionId: 'auditor', model: 'local-fixture', instructions: 'Сначала оцените повторные чтения.' },
      }), signal: AbortSignal.timeout(5000) };
    await new ModelApiRunner(new ProcessExecutor(), request).run(job, () => {});
    releaseAudit();
    const auditFile = path.join(directory, id + '.audit.json');
    let assessment = '';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      assessment = await readFile(auditFile, 'utf8').catch(() => '');
      if (assessment) break;
      await delay(25);
    }
    assert.ok(assessment, 'The background audit should be saved');
    const raw = await readFile(path.join(directory, id + '.json'), 'utf8');
    const record = JSON.parse(raw);
    assert.equal(record.evidence.tools.read_file.repeated, 1);
    assert.equal(record.evidence.firstInputTokens, 20);
    assert.equal(record.evidence.peakInputTokens, 60);
    assert.equal(JSON.parse(assessment).findings[0].observed, 1);
    assert.equal((auditInput as { model: string }).model, 'local-fixture');
    assert.match(JSON.stringify(auditInput), /Сначала оцените повторные чтения/);
    assert.doesNotMatch(raw + assessment + JSON.stringify(auditInput), /PRIVATE_SOURCE_SENTINEL|source\.ts/);
  } finally {
    releaseAudit();
    globalThis.fetch = originalFetch;
    if (previousDirectory === undefined) delete process.env.SAT_STAGE_AUDIT_DIR;
    else process.env.SAT_STAGE_AUDIT_DIR = previousDirectory;
    await rm(root, { recursive: true, force: true });
  }
});

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
    assert.equal((results[0] as { limited: boolean }).limited, true);
    assert.equal((results[0] as { endLine: number }).endLine, 3);
    assert.match(JSON.stringify(results[1]), /PRIVATE_SOURCE_SENTINEL/);
    assert.match(JSON.stringify(results[3]), /Use edit_file/);
    assert.equal(await readFile(path.join(root, 'source.ts'), 'utf8'), '// first\n' + replacement + '\n// end');
    assert.doesNotMatch(logs.join(''), /PRIVATE_SOURCE_SENTINEL|method source|OVERWRITE/);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});

test('explore_code returns the complete large symbol result instead of rejecting or retaining only its tail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-large-symbol-'));
  const logs: string[] = []; let turn = 0;
  const source = 'SOURCE_BEGIN\n' + 'x'.repeat(20000) + '\nSOURCE_END';
  class Fixture extends ProcessExecutor {
    public override async run(request: ProcessRequest) {
      assert.equal(request.command, 'codegraph');
      assert.ok(request.args.includes('CampfireRules.fuelAdditionSeconds'));
      assert.equal(request.maxOutputChars, Number.POSITIVE_INFINITY);
      return super.run({ ...request, command: process.execPath,
        args: ['-e', 'process.stdout.write("SOURCE_BEGIN\\n"+"x".repeat(20000)+"\\nSOURCE_END")'] });
    }
  }
  try {
    const request: typeof fetch = async (_url, options) => {
      if (turn++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'explore',
        function: { name: 'explore_code', arguments: JSON.stringify({ symbol: 'CampfireRules.fuelAdditionSeconds' }) },
      }] } }] });
      const messages = JSON.parse(String(options?.body)).messages;
      assert.equal(JSON.parse(messages.at(-1).content), source);
      return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"pass","summary":"explored"}' } }] });
    };
    await new ModelApiRunner(new Fixture(), request).run({ runId: 'large-symbol', cwd: root, prompt: 'Explore',
      profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'api', model: 'fixture', instructions: '' },
      connection: { id: 'api', label: 'API', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
      settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS), signal: AbortSignal.timeout(10000),
    }, text => { logs.push(text); });
    assert.match(logs.join(''), /explore_code CampfireRules.fuelAdditionSeconds: завершён/);
    assert.doesNotMatch(logs.join(''), /SOURCE_BEGIN|SOURCE_END|Symbol result is too large/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const ending of ['\n', '\r\n', 'mixed'] as const) {
  test(`API can edit its own read result while preserving ${JSON.stringify(ending)} line endings`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sat-model-eol-'));
    const eol = ending === 'mixed' ? '\r\n' : ending;
    const prefix = ending === 'mixed' ? 'prefix\n' : `prefix${eol}`;
    const source = `${prefix}first${eol}second${eol}tail${eol}`;
    let turn = 0;
    try {
      await writeFile(path.join(root, 'source.ts'), source);
      const request: typeof fetch = async (_url, options) => {
        const messages = JSON.parse(String(options?.body)).messages;
        let call: { name: string; arguments: string } | undefined;
        if (turn++ === 0) call = { name: 'read_file', arguments: JSON.stringify({ path: 'source.ts', startLine: 2, endLine: 3 }) };
        else if (turn === 2) {
          const read = JSON.parse(messages.at(-1).content);
          assert.equal(read.content, 'first\nsecond');
          call = { name: 'edit_file', arguments: JSON.stringify({ path: 'source.ts', oldText: read.content, newText: 'changed\nvalue $&' }) };
        } else assert.equal(JSON.parse(messages.at(-1).content).edited, true);
        return Response.json({ choices: [{ message: call ? { role: 'assistant', content: null, tool_calls: [{ id: String(turn), function: call }] }
          : { role: 'assistant', content: '{"verdict":"pass","summary":"edited"}' } }] });
      };
      await new ModelApiRunner(new ProcessExecutor(), request).run({ runId: 'eol', cwd: root, prompt: 'Edit exact read',
        profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'api', model: 'fixture', instructions: '' },
        connection: { id: 'api', label: 'API', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
        settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS), signal: AbortSignal.timeout(10000),
      }, () => {});
      assert.equal(await readFile(path.join(root, 'source.ts'), 'utf8'), `${prefix}changed${eol}value $&${eol}tail${eol}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const match of ['missing', 'multiple'] as const) {
  test(`API rejects ${match} normalized patch matches without changing the file`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sat-patch-identity-'));
    const source = 'first\r\nsecond\r\nfirst\nsecond\n'; let turn = 0;
    try {
      await writeFile(path.join(root, 'source.ts'), source);
      const request: typeof fetch = async (_url, options) => {
        if (turn++ === 0) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'edit',
          function: { name: 'edit_file', arguments: JSON.stringify({ path: 'source.ts', oldText: match === 'missing' ? 'absent' : 'first\nsecond', newText: 'replacement' }) },
        }] } }] });
        const messages = JSON.parse(String(options?.body)).messages;
        const error = JSON.parse(messages.at(-1).content).error;
        assert.match(error, /source.ts/); assert.match(error, match === 'missing' ? /found 0 matches/ : /found multiple matches/);
        return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"blocked","summary":"Needs current unique range"}' } }] });
      };
      await new ModelApiRunner(new ProcessExecutor(), request).run({ runId: 'identity', cwd: root, prompt: 'Patch',
        profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'api', model: 'fixture', instructions: '' },
        connection: { id: 'api', label: 'API', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
        settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS), signal: AbortSignal.timeout(10000),
      }, () => {});
      assert.equal(await readFile(path.join(root, 'source.ts'), 'utf8'), source);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
