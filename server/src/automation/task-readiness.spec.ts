import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { TaskStatus } from '../../../shared/tasks/status.js';
import { TaskAutomationReadiness } from '../../../shared/automation/task-readiness.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../../../shared/automation/presets.js';

function exampleSettings(): AutomationSettings {
  return { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/project',
    connections: [{ id: 'native', label: 'CLI', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map((role) => ({ id: role, role, runner: 'codex', connectionId: 'native', model: 'selected-model', instructions: '' })),
    pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] };
}

test('task readiness distinguishes DoR, analysis entry, questions, active runs and wrong statuses', () => {
  const settings = exampleSettings();
  const task = { status: TaskStatus.Ready, hasPlan: true, openQuestionsCount: 0 };
  assert.equal(TaskAutomationReadiness.evaluate(task, settings, false).dorReady, true);
  const analysis = TaskAutomationReadiness.evaluate({ ...task, status: TaskStatus.Backlog, hasPlan: false }, settings, false);
  assert.equal(analysis.dorReady, false); assert.equal(analysis.canStart, true); assert.equal(analysis.needsAnalysis, true);
  assert.equal(TaskAutomationReadiness.evaluate({ ...task, openQuestionsCount: 1 }, settings, false).canStart, false);
  assert.equal(TaskAutomationReadiness.evaluate(task, settings, true).canStart, false);
  assert.equal(TaskAutomationReadiness.evaluate({ ...task, status: TaskStatus.Testing }, settings, false).canStart, false);
  settings.pipeline.shift();
  assert.ok(TaskAutomationReadiness.evaluate({ ...task, hasPlan: false }, settings, false).reasons.some((reason) => reason.includes('аналитика')));
});

test('enqueue atomically saves the submitted draft and run, leaves settings unchanged on validation and duplicate failures', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure(exampleSettings());
    const task = app.taskService.createTask({ title: 'Launch current form' });
    const draft = exampleSettings(); draft.agents[0].model = '';
    assert.throws(() => service.enqueue(task.id, draft), /Invalid agent/);
    assert.equal(service.list(task.id).length, 0);
    assert.equal(service.settings().agents[0].model, 'selected-model');
    draft.agents[0].model = 'unsaved-ui-model';
    const run = service.enqueue(task.id, draft);
    assert.equal(service.settings().agents[0].model, 'unsaved-ui-model');
    assert.equal(run.settings.agents[0].model, 'unsaved-ui-model');
    draft.agents[0].model = 'changed-after-submit';
    assert.equal(service.detail(run.id).run.settings.agents[0].model, 'unsaved-ui-model');
    assert.throws(() => service.enqueue(task.id, draft), /active run/);
    assert.equal(service.settings().agents[0].model, 'unsaved-ui-model');
    assert.deepEqual(service.activeTaskIds(), [task.id]);
    service.cancel(run.id);
    assert.deepEqual(service.activeTaskIds(), []);
  } finally { app.close(); }
});

test('active task IDs are not limited by the recent runs display cap', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    app.automationService.configure(exampleSettings());
    for (let index = 0; index < 101; index++) app.automationService.enqueue(app.taskService.createTask({ title: `Queued ${index}` }).id);
    assert.equal(app.automationService.list().length, 100);
    assert.equal(app.automationService.activeTaskIds().length, 101);
  } finally { app.close(); }
});
