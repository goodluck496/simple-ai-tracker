import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';

test('task team overrides inherit project infrastructure and snapshots never change project defaults', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
      agents: (['developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })), pipeline: ['developer', 'tester', 'reviewer'], checks: [{ command: 'npm', args: ['test'] }] });
    const first = app.taskService.createTask({ title: 'Single developer' }); const second = app.taskService.createTask({ title: 'Full team' });
    app.taskService.attachPlan({ id: first.id, planContent: '# Approved plan', actor: 'agent' });
    const base = service.settings();
    const override = service.taskTeam(first.id, { ...base, repositoryPath: '/ignored', pipeline: ['developer'], executionMode: 'developer' });
    assert.equal(override.settings.repositoryPath, '/fixture'); assert.equal(override.overridden, true);
    assert.equal(service.taskTeam(second.id).overridden, false);
    assert.deepEqual(service.settings().pipeline, base.pipeline);
    const run = service.enqueue(first.id, undefined, false);
    assert.deepEqual(run.settings.pipeline, ['developer']); assert.equal(run.settings.executionMode, 'developer');
    service.configure({ ...base, baseBranch: 'next' });
    assert.equal(service.taskTeam(first.id).settings.baseBranch, 'next');
    assert.equal(service.detail(run.id).run.settings.baseBranch, base.baseBranch, 'Existing run is immutable');
    const owned = service.claim('fixture')!; service.beginStage(run.id, owned.leaseToken!);
    service.completeStage(run.id, owned.leaseToken!, { verdict: 'pass', summary: 'Implementation and configured checks passed', commitMessage: `[#${first.id}] - Выполнен план для проверки` }, `sat/${run.id}`, 'a'.repeat(40));
    assert.equal(service.detail(run.id).run.status, 'review'); assert.equal(app.taskService.getTaskCard(first.id).status, 'review');
    assert.equal(service.taskTeam(first.id, null).overridden, false);
    assert.deepEqual(service.taskTeam(first.id).settings.pipeline, base.pipeline);
    const noPlan = app.taskService.createTask({ title: 'No approved plan' });
    assert.throws(() => service.enqueue(noPlan.id, { ...base, executionMode: 'developer', pipeline: ['developer'] }, false), /existing plan|analyst/);
    assert.throws(() => service.enqueue(noPlan.id, { ...base, executionMode: 'team', pipeline: ['developer'] }, false), /developer, tester and reviewer/);
  } finally { app.close(); }
});
