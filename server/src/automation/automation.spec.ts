import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { AutomationSettingsValidator } from './settings.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../shared/automation/contracts.js';

export function exampleSettings(): AutomationSettings {
  return { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/project',
    connections: [{ id: 'native', label: 'Native CLI', kind: 'native', supportsImages: false }],
    agents: ['analyst', 'developer', 'tester', 'reviewer'].map((role) => ({ id: role, role: role as 'analyst' | 'developer' | 'tester' | 'reviewer',
      runner: 'codex', connectionId: 'native', model: 'selected-model', instructions: '' })),
    pipeline: ['analyst', 'developer', 'tester', 'reviewer'], checks: [{ command: 'npm', args: ['test'] }] };
}

test('automation settings validate image capabilities, provider compatibility and secret references', () => {
  const validator = new AutomationSettingsValidator();
  const config = exampleSettings();
  assert.equal(validator.validate(config).agents[0].runner, 'codex');
  config.agents[0].role = 'visual-validator';
  assert.throws(() => validator.validate(config), /image-capable/);
  config.connections[0].supportsImages = true;
  config.agents[0].runner = 'model-api';
  assert.throws(() => validator.validate(config), /endpoint/);
  config.connections[0].kind = 'ollama'; config.connections[0].baseUrl = 'http://localhost:11434';
  config.agents = [config.agents[0]]; config.pipeline = [config.agents[0].id];
  assert.equal(validator.validate(config).connections[0].kind, 'ollama');
  Object.assign(config.connections[0], { apiKey: 'do-not-persist' });
  assert.throws(() => validator.validate(config), /credentials/);
});

test('queued runs snapshot settings, fence workers, survive service access and require answers before resume', () => {
  let now = '2026-10-25T00:00:00.000Z';
  const app = createContainer({ config: { dbPath: ':memory:' }, clock: { now: () => now }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure(exampleSettings());
    const task = app.taskService.createTask({ title: 'Pipeline task' });
    const queued = service.enqueue(task.id);
    assert.equal(queued.leaseToken, null);
    assert.throws(() => service.enqueue(task.id), /active run/);
    service.configure({ ...exampleSettings(), timeoutMinutes: 45 });
    const run = service.claim('worker-1')!;
    assert.equal(run.settings.timeoutMinutes, 30);
    assert.equal(service.claim('worker-2'), null);
    assert.throws(() => service.heartbeat(run.id, 'wrong-token'), /lease/);
    service.beginStage(run.id, run.leaseToken!);
    service.completeStage(run.id, run.leaseToken!, { verdict: 'questions', summary: 'Need requirements', questions: ['Which behavior?'] }, `sat/${run.id}`, 'a'.repeat(40));
    assert.equal(service.detail(run.id).run.status, 'waiting');
    assert.throws(() => service.resume(run.id), /Answer task questions/);
    const question = app.taskService.getTaskCard(task.id).unansweredQuestions[0];
    app.taskService.answerQuestions({ id: task.id, answers: [{ questionId: question.id, answer: 'Use the documented behavior.' }], actor: 'user' });
    service.resume(run.id);
    const resumed = service.claim('worker-2')!;
    assert.notEqual(resumed.leaseToken, run.leaseToken);
    now = '2026-10-25T00:02:00.000Z';
    assert.equal(service.claim('worker-3'), null);
    assert.equal(service.detail(run.id).run.status, 'interrupted');
    assert.throws(() => service.progress(run.id, resumed.leaseToken!, 'stale output'), /lease/);
  } finally { app.close(); }
});

test('pipeline advances through plan, tests and review, bounded revision and cancellation', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure({ ...exampleSettings(), maxRevisions: 1, maxAgentCalls: 10 });
    const task = app.taskService.createTask({ title: 'Full lifecycle' });
    const queued = service.enqueue(task.id);
    const run = service.claim('worker')!;
    const token = run.leaseToken!;
    const finish = (verdict: 'pass' | 'changes_requested', plan?: string) => service.completeStage(run.id, token, { verdict, summary: verdict, plan }, `sat/${run.id}`, 'b'.repeat(40));
    service.beginStage(run.id, token); finish('pass', '# Plan\nImplement the requested behavior.');
    assert.equal(app.taskService.getTaskCard(task.id).status, 'ready');
    service.beginStage(run.id, token); finish('pass');
    service.beginStage(run.id, token); finish('pass');
    service.beginStage(run.id, token);
    assert.equal(finish('changes_requested').stage, 1);
    service.beginStage(run.id, token); finish('pass');
    service.beginStage(run.id, token); finish('pass');
    service.beginStage(run.id, token); finish('pass');
    assert.equal(service.detail(queued.id).run.status, 'review');
    assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
    assert.equal(service.detail(queued.id).run.leaseToken, null);
    const other = app.taskService.createTask({ title: 'Cancelled' });
    const cancelled = service.enqueue(other.id); const owned = service.claim('worker')!;
    service.cancel(cancelled.id);
    assert.throws(() => service.heartbeat(cancelled.id, owned.leaseToken!), /lease/);
  } finally { app.close(); }
});

test('queued cancellation is atomic with claim, keeps task and journal, and permits a new run', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService; service.configure(exampleSettings());
    const task = app.taskService.createTask({ title: 'Dequeue preserves this task' });
    const queued = service.enqueue(task.id);
    service.dequeue(queued.id);
    assert.equal(service.detail(queued.id).run.status, 'cancelled');
    assert.equal(service.claim('worker'), null);
    assert.equal(app.taskService.getTaskCard(task.id).title, 'Dequeue preserves this task');
    assert.ok(service.detail(queued.id).events.some((event) => event.text.includes('Убрано из очереди')));
    const next = service.enqueue(task.id);
    assert.notEqual(next.id, queued.id);
    const running = service.claim('worker')!;
    assert.equal(running.id, next.id);
    assert.throws(() => service.dequeue(running.id), /покинул очередь/);
    assert.equal(service.detail(running.id).run.status, 'running');
    service.cancel(running.id);
    assert.equal(service.detail(running.id).run.status, 'cancelled');
  } finally { app.close(); }
});
