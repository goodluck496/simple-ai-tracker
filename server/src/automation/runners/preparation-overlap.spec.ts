import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelApiRunner } from './model-api-runner.js';
import { ProcessExecutor } from './process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const mode of ['success', 'failure', 'cancel'] as const) {
  test(`API reads and checkpoints during setup; edits wait for ${mode}`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-overlap-'));
    const ready = deferred();
    const waiting = deferred();
    const controller = new AbortController();
    let turn = 0; let planned = false;
    const reply = (calls: { name: string; args: unknown }[]) => Response.json({ choices: [{ message: {
      role: 'assistant', content: null, tool_calls: calls.map((call, i) => ({ id: String(i),
        function: { name: call.name, arguments: JSON.stringify(call.args) } })),
    } }] });
    try {
      await writeFile(path.join(cwd, 'source.txt'), 'before');
      const request: typeof fetch = async (_url, options) => {
        const messages = JSON.parse(String(options?.body)).messages;
        if (turn++ === 0) return reply([{ name: 'read_file', args: { path: 'source.txt' } },
          { name: 'save_progress', args: { note: { summary: 'Read source and planned edit' } } }]);
        if (turn === 2) {
          assert.ok(JSON.stringify(messages).includes('before'));
          assert.equal(planned, true);
          return reply([{ name: 'edit_file', args: { path: 'source.txt', oldText: 'before', newText: 'after' } }]);
        }
        return Response.json({ choices: [{ message: { role: 'assistant', content: '{"verdict":"pass","summary":"edited"}' } }] });
      };
      const job: AgentJob = { cwd, runId: 'overlap', prompt: 'Read then edit', signal: controller.signal,
        profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'local', model: 'fixture', instructions: '' },
        connection: { id: 'local', label: 'Ollama', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
        settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS), onCheckpoint: async () => { planned = true; },
        waitForPreparation: async () => { waiting.resolve(); await ready.promise; },
      };
      const execution = new ModelApiRunner(new ProcessExecutor(), request).run(job, () => {});
      const settled = execution.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await waiting.promise;
      assert.equal(await readFile(path.join(cwd, 'source.txt'), 'utf8'), 'before');
      assert.equal(turn, 2, 'No model retries while waiting for setup');
      if (mode === 'failure') ready.reject(new Error('installation failed'));
      else { if (mode === 'cancel') controller.abort(new Error('user stopped')); ready.resolve(); }
      const result = await settled;
      if (mode === 'success') {
        assert.equal(result.error, undefined);
        assert.equal(await readFile(path.join(cwd, 'source.txt'), 'utf8'), 'after');
      } else {
        assert.match(String(result.error), mode === 'failure' ? /installation failed/ : /user stopped/);
        assert.equal(await readFile(path.join(cwd, 'source.txt'), 'utf8'), 'before');
        assert.equal(turn, 2);
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

for (const operation of ['run_check', 'call_project_tool', 'final'] as const) {
  test(`API ${operation} cannot bypass a failed preparation barrier`, async () => {
    let checks = 0;
    class Executor extends ProcessExecutor { public override async run() { checks++; return ''; } }
    const request: typeof fetch = async () => Response.json({ choices: [{ message: {
      role: 'assistant', content: '{"verdict":"pass","summary":"done"}',
      ...(operation === 'final' ? {} : { tool_calls: [{ id: '1', function: { name: operation,
        arguments: JSON.stringify(operation === 'run_check' ? { index: 0 } : { server: 'fixture', tool: 'mutate', arguments: {} }) } }] }),
    } }] });
    const job: AgentJob = { cwd: os.tmpdir(), runId: 'gate', prompt: '', signal: AbortSignal.timeout(5000),
      profile: { id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'api', model: 'fixture', instructions: '' },
      connection: { id: 'api', label: 'API', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
      settings: { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), checks: [{ command: 'fixture', args: [] }] },
      projectMcp: [{ name: 'fixture', command: 'never-start', args: [], envVars: [], tools: ['mutate'] }],
      waitForPreparation: async () => { throw new Error('setup failed'); },
    };
    await assert.rejects(new ModelApiRunner(new Executor(), request).run(job, () => {}), /setup failed/);
    assert.equal(checks, 0);
  });
}

test('API read progress identifies files and clamps large ranges without exposing contents', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-read-progress-'));
  const progress: string[] = []; let turn = 0;
  try {
    await writeFile(path.join(cwd, 'source.ts'), Array.from({ length: 100 }, (_, i) => `PRIVATE_SOURCE_${i + 1}`).join('\n'));
    const calls = [
      { path: 'source.ts', startLine: 5, endLine: 100 },
      { path: 'source.ts', startLine: 80, endLine: 70 },
      { path: 'missing.ts', startLine: 1, endLine: 10 },
    ];
    const request: typeof fetch = async (_url, options) => {
      const messages = JSON.parse(String(options?.body)).messages;
      if (turn === 1) {
        const result = JSON.parse(messages.at(-1).content);
        assert.equal(result.startLine, 5); assert.equal(result.endLine, 44);
        assert.equal(result.limited, true); assert.equal(result.nextStartLine, 45);
        assert.equal(result.content.split('\n').length, 40);
      }
      if (turn === 2) assert.match(messages.at(-1).content, /startLine=80, endLine=70/);
      const args = calls[turn++];
      return Response.json({ choices: [{ message: args
        ? { role: 'assistant', content: null, tool_calls: [{ id: String(turn), function: { name: 'read_file', arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: '{"verdict":"pass","summary":"read"}' },
      }] });
    };
    await new ModelApiRunner(new ProcessExecutor(), request).run({ cwd, runId: 'read', prompt: '', signal: AbortSignal.timeout(5000),
      profile: { id: 'review', role: 'reviewer', runner: 'model-api', connectionId: 'local', model: 'fixture', instructions: '' },
      connection: { id: 'local', label: 'Ollama', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false },
      settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS),
    }, text => { progress.push(text); });
    assert.match(progress.join(''), /read_file source.ts:5–100: выполняется/);
    assert.match(progress.join(''), /read_file source.ts:5–44: завершён.*40/);
    assert.match(progress.join(''), /read_file missing.ts:1–10: ошибка/);
    assert.doesNotMatch(progress.join(''), /PRIVATE_SOURCE/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
