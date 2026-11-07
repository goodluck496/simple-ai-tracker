import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import { ProcessExecutor, PROCESS_PROGRESS_MS } from './process-executor.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';

test('compact commands report liveness before exit, including quiet output', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const messages: string[] = [];
  const execution = new ProcessExecutor().run({ command: process.execPath,
    args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], cwd: os.tmpdir(), signal: controller.signal,
    compactProgress: true, onStdout: ready, onProgress: text => { messages.push(text); },
  });
  const cancelled = assert.rejects(execution, /cancelled/);
  try {
    await started;
    assert.match(messages[0], /Выполняется/);
    assert.ok(!messages[0].includes('process.stdout'));
    context.mock.timers.tick(PROCESS_PROGRESS_MS);
    assert.match(messages.at(-1)!, /без вывода.*Процент команды неизвестен/);
  } finally { controller.abort(); await cancelled; }
  const count = messages.length;
  context.mock.timers.tick(PROCESS_PROGRESS_MS);
  assert.equal(messages.length, count, 'No progress timer after command exit');
});

test('live output retains bounded npm status and excludes source bodies', () => {
  assert.equal(CompactProgress.liveOutput('const source = "hidden";'), '');
  const output = CompactProgress.liveOutput('npm http fetch GET 200 https://user:pass@host/pkg?token=secret\nconst code=1;');
  assert.match(output, /npm http/); assert.ok(!output.includes('pass')); assert.ok(!output.includes('secret')); assert.ok(!output.includes('const code'));
});

test('compact failures retain the network code from JSON stdout even when stderr contains noise', async () => {
  const messages: string[] = [];
  await assert.rejects(new ProcessExecutor().run({ command: process.execPath,
    args: ['-e', "console.error('warning');console.log(JSON.stringify({type:'error',error:{code:'ETIMEDOUT',message:'private endpoint'}}));process.exitCode=1"],
    cwd: os.tmpdir(), signal: AbortSignal.timeout(5000), compactProgress: true,
    onProgress: text => messages.push(text),
  }), /Истекло время ожидания соединения \(ETIMEDOUT\)/);
  assert.match(messages.join('\n'), /ETIMEDOUT/);
  assert.doesNotMatch(messages.join('\n'), /private endpoint/);
});
