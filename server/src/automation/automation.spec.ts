import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { AutomationSettingsValidator } from './settings.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { checkFingerprint } from './check-evidence.js';
import { randomUUID } from 'node:crypto';

export function exampleSettings(): AutomationSettings {
  return { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/project',
    connections: [{ id: 'native', label: 'Native CLI', kind: 'native', supportsImages: false }],
    agents: ['analyst', 'developer', 'tester', 'reviewer'].map((role) => ({ id: role, role: role as 'analyst' | 'developer' | 'tester' | 'reviewer',
      runner: 'codex', connectionId: 'native', model: 'selected-model', instructions: '' })),
    pipeline: ['analyst', 'developer', 'tester', 'reviewer'], checks: [{ command: 'npm', args: ['test'] }] };
}

test('resuming with current project checks retains the run and its progress', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    const settings = service.configure(exampleSettings());
    const task = app.taskService.createTask({ title: 'Update a failed check' });
    const run = service.enqueue(task.id);
    const owned = service.claim('fixture')!;
    service.fail(run.id, owned.leaseToken!, 'Configured check script unavailable');
    const checks = [{ command: 'pnpm', args: ['run', 'build:browser'] }];
    service.configure({ ...settings, checks });
    const resumed = service.resume(run.id, undefined, undefined, false, true);
    assert.equal(resumed.id, run.id);
    assert.equal(resumed.stage, run.stage);
    assert.equal(resumed.status, 'queued');
    assert.deepEqual(resumed.settings.checks, checks);
    assert.deepEqual(resumed.settings.pipeline, run.settings.pipeline);
  } finally { app.close(); }
});

test('automation settings allow source-based visual validation and validate provider compatibility and secret references', () => {
  const validator = new AutomationSettingsValidator();
  const config = exampleSettings();
  assert.equal(validator.validate(config).agents[0].runner, 'codex');
  config.agents[0].role = 'visual-validator';
  assert.equal(validator.validate(config).agents[0].role, 'visual-validator');
  config.connections[0].supportsImages = true;
  config.agents[0].runner = 'model-api';
  assert.throws(() => validator.validate(config), /endpoint/);
  config.connections[0].kind = 'ollama'; config.connections[0].baseUrl = 'http://localhost:11434';
  config.agents = [config.agents[0]]; config.pipeline = [config.agents[0].id];
  assert.equal(validator.validate(config).connections[0].kind, 'ollama');
  Object.assign(config.connections[0], { apiKey: 'do-not-persist' });
  assert.throws(() => validator.validate(config), /credentials/);
});

test('automation settings validate and preserve postOperations', () => {
  const validator = new AutomationSettingsValidator();
  const config = exampleSettings();
  config.postOperations = [{ command: 'npm', args: ['run', 'lint'] }];
  const validated = validator.validate(config);
  assert.equal(validated.postOperations?.length, 1);
  assert.equal(validated.postOperations[0].command, 'npm');
  assert.deepEqual(validated.postOperations[0].args, ['run', 'lint']);

  // Invalid post-operation command
  config.postOperations = [{ command: '', args: [] }];
  assert.throws(() => validator.validate(config), /Invalid post-operation command/);
});

test('queued runs snapshot settings, fence workers, survive service access and require answers before resume', () => {
  let now = '2026-10-25T00:00:00.000Z';
  const app = createContainer({ config: { dbPath: ':memory:' }, clock: { now: () => now }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure(exampleSettings());
    const task = app.taskService.createTask({ title: 'Pipeline task' });
    const queued = service.enqueue(task.id);
    assert.equal(queued.startedAt, undefined);
    assert.equal(queued.finishedAt, undefined);
    assert.equal(queued.leaseToken, null);
    assert.throws(() => service.enqueue(task.id), /active run/);
    service.configure({ ...exampleSettings(), timeoutMinutes: 45 });
    const run = service.claim('worker-1')!;
    assert.equal(run.startedAt, now);
    assert.equal(run.attemptStartedAt, now);
    assert.equal(run.finishedAt, undefined);
    const projected = service.queue().items.find((item) => item.id === run.id)!;
    assert.equal(projected.startedAt, now);
    assert.equal(projected.attemptStartedAt, now);
    assert.equal(projected.finishedAt, undefined);
    assert.equal(run.settings.timeoutMinutes, 30);
    assert.equal(service.claim('worker-2'), null);
    assert.throws(() => service.heartbeat(run.id, 'wrong-token'), /lease/);
    service.beginStage(run.id, run.leaseToken!);
    now = '2026-10-25T00:01:00.000Z';
    service.heartbeat(run.id, run.leaseToken!);
    service.progress(run.id, run.leaseToken!, 'in progress');
    assert.equal(service.detail(run.id).run.startedAt, '2026-10-25T00:00:00.000Z');
    assert.equal(service.detail(run.id).run.finishedAt, undefined);
    service.completeStage(run.id, run.leaseToken!, { verdict: 'questions', summary: 'Need requirements', questions: ['Which behavior?'] }, `sat/${run.id}`, 'a'.repeat(40));
    assert.equal(service.detail(run.id).run.status, 'waiting');
    assert.equal(service.detail(run.id).run.finishedAt, undefined);
    assert.throws(() => service.resume(run.id), /Answer task questions/);
    const question = app.taskService.getTaskCard(task.id).unansweredQuestions[0];
    app.taskService.answerQuestions({ id: task.id, answers: [{ questionId: question.id, answer: 'Use the documented behavior.' }], actor: 'user' });
    now = '2026-10-25T00:02:00.000Z';
    service.resume(run.id);
    assert.equal(service.detail(run.id).run.finishedAt, undefined);
    const resumed = service.claim('worker-2')!;
    assert.notEqual(resumed.leaseToken, run.leaseToken);
    assert.equal(resumed.startedAt, '2026-10-25T00:00:00.000Z');
    assert.equal(resumed.attemptStartedAt, now);
    now = '2026-10-25T00:04:00.000Z';
    assert.equal(service.claim('worker-3'), null);
    assert.equal(service.detail(run.id).run.status, 'interrupted');
    assert.equal(service.detail(run.id).run.finishedAt, now);
    service.resume(run.id);
    assert.equal(service.detail(run.id).run.finishedAt, undefined);
    const finalAttempt = service.claim('worker-4')!;
    assert.equal(finalAttempt.startedAt, '2026-10-25T00:00:00.000Z');
    now = '2026-10-25T00:05:00.000Z';
    service.fail(finalAttempt.id, finalAttempt.leaseToken!, 'worker failed');
    assert.equal(service.detail(finalAttempt.id).run.finishedAt, now);
    assert.equal(service.queue().items.find((item) => item.id === run.id)?.finishedAt, now);
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
    assert.ok(service.detail(queued.id).run.finishedAt);
    assert.equal(service.detail(queued.id).run.updatedAt, service.detail(queued.id).run.finishedAt);
    assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
    assert.equal(service.detail(queued.id).run.leaseToken, null);
    const other = app.taskService.createTask({ title: 'Cancelled' });
    const cancelled = service.enqueue(other.id); const owned = service.claim('worker')!;
    service.cancel(cancelled.id);
    assert.ok(service.detail(cancelled.id).run.finishedAt);
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

test('run archive is persistent, workspace scoped, terminal only, and restores without deleting events', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-archive-'));
  const config = { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db') };
  const app = createContainer({ config, logger: new SilentLogger() });
  try {
    const service = app.automationService; service.configure(exampleSettings());
    const task = app.taskService.createTask({ title: 'Archive lifecycle' });
    const queued = service.enqueue(task.id);
    assert.throws(() => service.hide(queued.id), /Active runs cannot be hidden/);
    service.dequeue(queued.id);
    const before = service.detail(queued.id).events.length;
    service.hide(queued.id); service.hide(queued.id);
    assert.equal(service.queue().items.some((item) => item.id === queued.id), false);
    assert.equal(service.list().some((run) => run.id === queued.id), false);
    assert.equal(service.archive().length, 1);
    const reopened = createContainer({ config, logger: new SilentLogger() });
    try { assert.equal(reopened.automationService.archive()[0].id, queued.id); } finally { reopened.close(); }
    assert.equal(service.detail(queued.id).events.length, before);
    const task2 = app.taskService.createTask({ title: 'Workspace isolation' });
    const other = service.enqueue(task2.id); service.dequeue(other.id);
    const isolated = 'isolated-' + Date.now(); app.workspaceManager.create(isolated, 'Isolated workspace');
    app.workspaceManager.within(isolated, () => {
      const isolatedService = app.workspaceManager.active.automationService;
      isolatedService.configure(exampleSettings());
      assert.equal(isolatedService.archive().length, 0);
      assert.throws(() => isolatedService.restore(queued.id), /not found/i);
    });
    service.restore(queued.id); service.restore(queued.id);
    assert.equal(service.queue().items.some((item) => item.id === queued.id), true);
    assert.equal(service.archive().length, 0);
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('metrics track two runs of one task before and after user done, both done paths, reopen, first attempt, boundaries, >200 runs, legacy unknown and detail eventId', () => {
  let nowMs = Date.parse('2026-11-10T10:00:00.000Z');
  const clock = { now: () => new Date(nowMs).toISOString() };
  const app = createContainer({ config: { dbPath: ':memory:' }, clock, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    const cfg: AutomationSettings = {
      ...exampleSettings(),
      mergePolicy: 'manual',
      pipeline: ['developer', 'tester'],
      agents: [
        { id: 'developer', role: 'developer', runner: 'codex', connectionId: 'native', model: 'm', instructions: '' },
        { id: 'tester', role: 'tester', runner: 'codex', connectionId: 'native', model: 'm', instructions: '' },
      ],
      checks: [{ command: 'npm', args: ['test'] }],
    };
    service.configure(cfg);
    const fp = checkFingerprint(cfg.checks);
    const sha = 'a'.repeat(40);

    const recordStageCheck = (runId: string, token: string, stage: number, revision: number, code: number) => {
      const id = randomUUID();
      const base = {
        id, runId, attempt: 1, stage, phase: 'stage' as const, revision, sha,
        fingerprint: fp, position: 0, command: 'npm', args: ['test'], at: clock.now(),
      };
      service.checkExecution(runId, token, { ...base, outcome: { kind: 'unknown' } }, true);
      service.checkExecution(runId, token, { ...base, outcome: { kind: 'exit', code } }, false);
      return id;
    };

    // 1. Two runs of one task: first fails on check, second passes and awaits user
    const task1 = app.taskService.createTask({ title: 'Two-run task' });
    app.taskService.attachPlan({ id: task1.id, planContent: '# Plan\n1. Do work.' });
    const r1 = service.enqueue(task1.id);
    const c1 = service.claim('w1')!;
    service.beginStage(r1.id, c1.leaseToken!);
    service.completeStage(r1.id, c1.leaseToken!, { verdict: 'pass', summary: 'dev ok' }, `sat/${r1.id}`, sha);
    service.beginStage(r1.id, c1.leaseToken!);
    recordStageCheck(r1.id, c1.leaseToken!, 1, 0, 1);
    service.fail(r1.id, c1.leaseToken!, 'test failed');

    nowMs += 60_000;
    app.taskService.setStatus({ id: task1.id, status: 'ready', actor: 'user' });
    const r2 = service.enqueue(task1.id);
    const c2 = service.claim('w1')!;
    service.beginStage(r2.id, c2.leaseToken!);
    service.completeStage(r2.id, c2.leaseToken!, { verdict: 'pass', summary: 'dev ok' }, `sat/${r2.id}`, sha);
    service.beginStage(r2.id, c2.leaseToken!);
    const checkId2 = recordStageCheck(r2.id, c2.leaseToken!, 1, 0, 0);
    service.completeStage(r2.id, c2.leaseToken!, { verdict: 'pass', summary: 'tests ok' }, `sat/${r2.id}`, sha, undefined, false, [checkId2]);

    const beforeDone = service.metrics({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' });
    assert.equal(beforeDone.runs, 2);
    assert.equal(beforeDone.tasks, 1);
    assert.deepEqual(beforeDone.technical, { numerator: 1, denominator: 2 });
    assert.deepEqual(beforeDone.acceptance, { numerator: 0, denominator: 1 });
    assert.equal(beforeDone.awaitingAcceptance, 1);
    assert.equal(beforeDone.acceptedFirstAttempt, 0);

    // User marks done -> acceptance 1/1, technical still 1/2, first attempt still 0
    nowMs += 60_000;
    app.taskService.setStatus({ id: task1.id, status: 'done', actor: 'user' });
    const afterDone = service.metrics({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' });
    assert.deepEqual(afterDone.technical, { numerator: 1, denominator: 2 });
    assert.deepEqual(afterDone.acceptance, { numerator: 1, denominator: 1 });
    assert.equal(afterDone.awaitingAcceptance, 0);
    assert.equal(afterDone.acceptedFirstAttempt, 0);

    // Reopening removes task from acceptance numerator
    nowMs += 60_000;
    app.taskService.setStatus({ id: task1.id, status: 'in_progress', actor: 'user' });
    assert.equal(service.metrics({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' }).acceptance.numerator, 0);

    // Move to done via moveTask counts as acceptance; reorder inside done does not break it
    nowMs += 60_000;
    app.taskService.moveTask({ id: task1.id, status: 'done', actor: 'user' });
    app.taskService.moveTask({ id: task1.id, status: 'done', actor: 'user' });
    assert.equal(service.metrics({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' }).acceptance.numerator, 1);

    // 2. First-attempt acceptance with repeated claim (lease expiry) still counts as first attempt
    nowMs += 60_000;
    const task2 = app.taskService.createTask({ title: 'First attempt task' });
    app.taskService.attachPlan({ id: task2.id, planContent: '# Plan\n1. Clean pass.' });
    const r3 = service.enqueue(task2.id);
    const c3a = service.claim('w1')!;
    const firstStartedAt = c3a.startedAt;
    nowMs += 10 * 60_000; // expire lease
    service.detail(r3.id);
    service.resume(r3.id);
    const c3b = service.claim('w2')!;
    assert.equal(c3b.startedAt, firstStartedAt, 'Repeated claim preserves first startedAt');
    service.beginStage(r3.id, c3b.leaseToken!);
    service.completeStage(r3.id, c3b.leaseToken!, { verdict: 'pass', summary: 'dev ok' }, `sat/${r3.id}`, sha);
    service.beginStage(r3.id, c3b.leaseToken!);
    const checkId3 = recordStageCheck(r3.id, c3b.leaseToken!, 1, 0, 0);
    service.completeStage(r3.id, c3b.leaseToken!, { verdict: 'pass', summary: 'tests ok' }, `sat/${r3.id}`, sha, undefined, false, [checkId3]);
    nowMs += 60_000;
    app.taskService.setStatus({ id: task2.id, status: 'done', actor: 'user' });
    // Archive r3 and verify archived runs remain included
    service.hide(r3.id);

    const withFirst = service.metrics({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' });
    assert.equal(withFirst.runs, 3);
    assert.equal(withFirst.acceptedFirstAttempt, 1);

    // 3. Period validation and empty cohort
    assert.throws(() => service.metrics({ from: '2026-11-20T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }), /Начало должно быть раньше конца/);
    assert.throws(() => service.metrics({ from: 'not-a-date', to: '2026-11-20T00:00:00.000Z' }), /корректные даты/);
    const empty = service.metrics({ from: '2025-01-01T00:00:00.000Z', to: '2025-01-02T00:00:00.000Z' });
    assert.equal(empty.runs, 0);
    assert.deepEqual(empty.technical, { numerator: 0, denominator: 0 });
    assert.deepEqual(empty.acceptance, { numerator: 0, denominator: 0 });

    // 4. Legacy run without check facts counts as unknown, and >200 runs are all counted
    const runsRepo = service['runs'];
    for (let i = 0; i < 205; i++) {
      const legacyId = `legacy-${i}`;
      const startedAt = '2026-10-15T12:00:00.000Z';
      runsRepo.save({
        ...r2, id: legacyId, status: 'review', startedAt, updatedAt: startedAt, finishedAt: startedAt,
        stageChecks: undefined,
      });
      if (i % 2 === 0) service.hide(legacyId);
    }
    const oct = service.metrics({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' });
    assert.equal(oct.runs, 205);
    assert.equal(oct.unknown, 205);
    assert.deepEqual(oct.technical, { numerator: 0, denominator: 0 });

    // 5. detail(runId, eventId) fetches event outside last 200 events and rejects wrong runId
    const earlyEventId = runsRepo.event(r1.id, 'note', 'very old event', '2026-11-10T10:00:01.000Z');
    for (let i = 0; i < 210; i++) runsRepo.event(r1.id, 'note', `filler ${i}`, '2026-11-10T10:01:00.000Z');
    const detail = service.detail(r1.id, earlyEventId);
    assert.equal(detail.selectedEvent?.id, earlyEventId);
    assert.equal(detail.events.some(e => e.id === earlyEventId), false);
    assert.equal(service.detail(r2.id, earlyEventId).selectedEvent, undefined);
  } finally { app.close(); }
});
