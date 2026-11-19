import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { ImprovementService } from './improvement-service.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';

function setup(workspace = 'simple-ai-tracker') {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  const runs = app.automationService['runs'];
  const service = new ImprovementService(runs, app.taskService, workspace);
  app.db.prepare(`INSERT INTO tasks(id, seq, type, title, description, status, created_at, updated_at)
    VALUES ('SAT-55', 55, 'feature', 'Самоулучшение', 'Feature', 'backlog', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run();
  const task = app.taskService.createTask({ title: 'Target task' });
  app.automationService.configure({
    ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
    agents: [{ id: 'analyst', role: 'analyst', runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' }],
    pipeline: ['analyst'],
  });
  const run1 = app.automationService.enqueue(task.id);
  const owned1 = app.automationService.claim('w1')!;
  const event1 = runs.event(run1.id, 'failed', 'Command failed', '2026-11-19T10:00:00.000Z');
  app.automationService.cancel(run1.id);
  const run2 = app.automationService.enqueue(task.id);
  const event2 = runs.event(run2.id, 'failed', 'Command failed again', '2026-11-19T11:00:00.000Z');
  return { app, runs, service, task, run1, run2, event1, event2, owned1 };
}

test('ImprovementService creates SAT-55 subtask on first failure, deduplicates redelivery, and updates on confirmed repeat', () => {
  const { app, service, task, run1, run2, event1, event2 } = setup();
  try {
    const first = service.recordOccurrence({
      runId: run1.id, eventId: event1, taskId: task.id, at: '2026-11-19T10:00:00.000Z',
      phase: 'checks', fact: 'npm run build exited with 1',
      cause: { key: 'missing-script:build', description: 'Отсутствует скрипт build' },
    });
    assert.equal(first.reviewState, 'new');
    assert.ok(first.improvementTaskId);
    const card1 = app.taskService.getTaskCard(first.improvementTaskId!);
    assert.equal(card1.parentId, 'SAT-55');
    assert.equal(card1.status, 'backlog');
    assert.match(card1.description, /Отсутствует скрипт build/);
    assert.match(card1.description, new RegExp(`eventId=${event1}`));

    // Redelivery / concurrent duplicate for same (runId, eventId) returns same occurrence without new card or comment
    const duplicate = service.recordOccurrence({
      runId: run1.id, eventId: event1, taskId: task.id, at: '2026-11-19T10:00:00.000Z',
      phase: 'checks', fact: 'npm run build exited with 1',
      cause: { key: 'missing-script:build', description: 'Отсутствует скрипт build' },
    });
    assert.equal(duplicate.improvementTaskId, first.improvementTaskId);
    assert.equal(app.taskService.getTaskCard(first.improvementTaskId!).comments.length, 0);

    // Confirmed repeat with same cause key updates managed section and adds comment
    const repeat = service.recordOccurrence({
      runId: run2.id, eventId: event2, taskId: task.id, at: '2026-11-19T11:00:00.000Z',
      phase: 'checks', fact: 'npm run build exited with 1 on retry',
      cause: { key: 'missing-script:build', description: 'Отсутствует скрипт build' },
    });
    assert.equal(repeat.reviewState, 'repeated');
    assert.equal(repeat.improvementTaskId, first.improvementTaskId);
    const cardAfterRepeat = app.taskService.getTaskCard(first.improvementTaskId!);
    assert.equal(cardAfterRepeat.comments.length, 1);
    assert.match(cardAfterRepeat.comments[0].text, new RegExp(`eventId=${event2}`));
  } finally { app.close(); }
});

test('ImprovementService does not merge unknown causes with identical error text', () => {
  const { app, service, task, run1, run2, event1, event2 } = setup();
  try {
    const a = service.recordOccurrence({
      runId: run1.id, eventId: event1, taskId: task.id, at: '2026-11-19T10:00:00.000Z',
      phase: 'developer', fact: 'CLI exited with code 1',
    });
    const b = service.recordOccurrence({
      runId: run2.id, eventId: event2, taskId: task.id, at: '2026-11-19T11:00:00.000Z',
      phase: 'developer', fact: 'CLI exited with code 1',
    });
    assert.ok(a.improvementTaskId && b.improvementTaskId);
    assert.notEqual(a.improvementTaskId, b.improvementTaskId);
    assert.equal(a.confirmedCause, undefined);
    assert.equal(b.confirmedCause, undefined);
  } finally { app.close(); }
});

test('ImprovementService preserves user manual edits and done status on repeat after done', () => {
  const { app, service, task, run1, run2, event1, event2 } = setup();
  try {
    const first = service.recordOccurrence({
      runId: run1.id, eventId: event1, taskId: task.id, at: '2026-11-19T10:00:00.000Z',
      phase: 'checks', fact: 'Missing lint script',
      cause: { key: 'missing-script:lint', description: 'Отсутствует скрипт lint' },
    });
    const cardId = first.improvementTaskId!;
    const card = app.taskService.getTaskCard(cardId);
    app.taskService.updateTask({ id: cardId, description: `Ручная заметка сверху\n\n${card.description}\n\nРучная заметка снизу` });
    app.taskService.setStatus({ id: cardId, status: 'done', actor: 'user' });

    const repeat = service.recordOccurrence({
      runId: run2.id, eventId: event2, taskId: task.id, at: '2026-11-19T11:00:00.000Z',
      phase: 'checks', fact: 'Missing lint script again',
      cause: { key: 'missing-script:lint', description: 'Отсутствует скрипт lint' },
    });
    assert.equal(repeat.reviewState, 'repeated_after_done');
    const updated = app.taskService.getTaskCard(cardId);
    assert.equal(updated.status, 'done');
    assert.match(updated.description, /Ручная заметка сверху/);
    assert.match(updated.description, /Ручная заметка снизу/);
    assert.match(updated.description, /Сбой повторился после исправления/);
    assert.equal(updated.comments.length, 1);
  } finally { app.close(); }
});

test('ImprovementService prevents recursion on SAT-55 and its subtasks and isolates other workspaces', () => {
  const { app, runs, service } = setup('simple-ai-tracker');
  try {
    const subtask = app.taskService.createTask({ title: 'Improvement subtask', parentId: 'SAT-55' });
    const runSub = app.automationService.enqueue(subtask.id);
    const evSub = runs.event(runSub.id, 'failed', 'Subtask failed', '2026-11-19T12:00:00.000Z');
    const occSub = service.recordOccurrence({
      runId: runSub.id, eventId: evSub, taskId: subtask.id, at: '2026-11-19T12:00:00.000Z',
      phase: 'developer', fact: 'Subtask failed',
    });
    assert.equal(occSub.improvementTaskId, undefined);

    const runFeature = app.automationService.enqueue('SAT-55');
    const evFeature = runs.event(runFeature.id, 'failed', 'Feature failed', '2026-11-19T12:05:00.000Z');
    const occFeature = service.recordOccurrence({
      runId: runFeature.id, eventId: evFeature, taskId: 'SAT-55', at: '2026-11-19T12:05:00.000Z',
      phase: 'developer', fact: 'Feature failed',
    });
    assert.equal(occFeature.improvementTaskId, undefined);
  } finally { app.close(); }

  const other = setup('other-workspace');
  try {
    const occ = other.service.recordOccurrence({
      runId: other.run1.id, eventId: other.event1, taskId: other.task.id, at: '2026-11-19T10:00:00.000Z',
      phase: 'checks', fact: 'Failure in other workspace',
      cause: { key: 'missing-script:test', description: 'Missing test script' },
    });
    assert.equal(occ.improvementTaskId, undefined);
  } finally { other.app.close(); }
});
