import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { StageNotes } from '../../../shared/automation/stage-note.js';
import { AgentHandoff } from '../../../shared/automation/handoff.js';

const note = { summary: 'Путь обработки локализован', findings: ['Пакеты отправляются независимо от ввода'], nextStep: 'Проверить сглаживание позиции', files: ['view.ts#update'], checks: ['focused test: exit 0, 3 passed'] };

test('checkpoints accept bounded prose, reject code/diff/raw output and bound context history', () => {
  assert.deepEqual(StageNotes.parse(note), note);
  const finalNote = { summary: 'Изменение завершено; проверка успешна', completedSteps: ['S1', 'S2', 'S3'], checks: ['node check.cjs: exit 0'] };
  assert.deepEqual(StageNotes.parse(finalNote), finalNote, 'Real CLI final note may omit nextStep');
  assert.match(StageNotes.format(StageNotes.parse(finalNote)), /не завершение этапа/);
  for (const bad of ['```ts code```', 'const answer = 1', 'diff --git a/b b/b', 'line1\nline2', 'call() => result', 'if (x) { code }', 'a'.repeat(601)])
    assert.throws(() => StageNotes.parse({ ...note, summary: bad }));
  assert.throws(() => StageNotes.parse({ ...note, code: 'source' }));
  assert.throws(() => StageNotes.parse({ ...note, files: Array(7).fill('x') }));
  const packet = JSON.parse(AgentHandoff.task({ id: 'SAT-1', comments: [
    { text: '[CHECKPOINT old] old fact' }, { text: 'RAW_OUTPUT'.repeat(10000) }, { text: '[CHECKPOINT latest] new fact' },
  ] }));
  assert.equal(packet.progressNotes.length, 1);
  assert.match(packet.progressNotes[0].text, /new fact/);
  assert.equal(packet.progressNotes[0].unverified, true);
  assert.doesNotMatch(JSON.stringify(packet), /RAW_OUTPUT|old fact/);
});

test('checkpoint MCP persistence is lease/attempt fenced and deduplicated across resume', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
      connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
      agents: [{ id: 'analyst', role: 'analyst', runner: 'antigravity', model: 'fixture', connectionId: 'n', instructions: '' }], pipeline: ['analyst'] });
    const task = app.taskService.createTask({ title: 'Checkpoint fixture' });
    const queued = service.enqueue(task.id);
    const run = service.claim('worker')!;
    const attempt = service.beginStage(run.id, run.leaseToken!);
    const update = { key: 'a'.repeat(64), conversationId: 'session-1', note };
    assert.throws(() => service.checkpoint(run.id, 'wrong-lease', attempt, update), /lease/);
    service.checkpoint(run.id, run.leaseToken!, attempt, update);
    service.checkpoint(run.id, run.leaseToken!, attempt, update);
    service.usage(run.id, run.leaseToken!, attempt, { inputTokens: 100, outputTokens: 10, source: 'antigravity-json', reportedRequests: 3, missingRequests: 0 }, false);
    assert.equal(service.detail(run.id).events.filter(event => event.kind === 'checkpoint').length, 1);
    assert.throws(() => service.checkpoint(run.id, run.leaseToken!, attempt, { ...update, conversationId: 'other-session' }), /conversation changed/);
    service.fail(run.id, run.leaseToken!, 'fixture interruption');
    service.resume(queued.id);
    const resumed = service.claim('worker-2')!;
    assert.equal(resumed.stageMemory?.conversationId, 'session-1');
    assert.deepEqual(resumed.stageMemory?.note, note);
    const nextAttempt = service.beginStage(run.id, resumed.leaseToken!);
    assert.throws(() => service.checkpoint(run.id, run.leaseToken!, attempt, update), /lease/);
    assert.throws(() => service.checkpoint(run.id, resumed.leaseToken!, attempt, update), /inactive agent/);
    service.checkpoint(run.id, resumed.leaseToken!, nextAttempt, update);
    assert.equal(service.detail(run.id).events.filter(event => event.kind === 'checkpoint').length, 1);
    service.checkpoint(run.id, resumed.leaseToken!, nextAttempt, { key: 'b'.repeat(64), conversationId: 'session-2', note });
    assert.equal(service.detail(run.id).run.stageMemory?.conversationId, 'session-2');
    assert.equal(service.detail(run.id).events.filter(event => event.kind === 'checkpoint').length, 2);
    service.usage(run.id, resumed.leaseToken!, nextAttempt, { inputTokens: 100, outputTokens: 10, source: 'antigravity-json', reportedRequests: 3, missingRequests: 0 }, false);
    service.usage(run.id, resumed.leaseToken!, nextAttempt, { inputTokens: 90, outputTokens: 9, source: 'antigravity-json', reportedRequests: 1, missingRequests: 0 }, true);
    assert.equal(service.detail(run.id).run.usageAttempts!.at(-1)!.finished, true);
    assert.equal(service.detail(run.id).run.usageAttempts!.at(-1)!.usage!.inputTokens, 90, 'Final aggregate replaces partial records');
  } finally { app.close(); }
});
