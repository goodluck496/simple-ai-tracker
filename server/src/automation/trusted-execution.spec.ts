import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { RunBudget } from '../../../shared/automation/budget.js';

test('task trust defaults off, requires user, snapshots per run and bypasses all execution quotas', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const tasks = app.taskService, service = app.automationService;
    service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', maxAgentCalls: 1, maxInputTokens: 1, maxRunMinutes: 1, maxRevisions: 0,
      connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
      agents: (['developer', 'tester'] as const).map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })), pipeline: ['developer', 'tester'], checks: [{ command: 'node', args: ['--version'] }] });
    const normal = tasks.createTask({ title: 'Default limited' });
    assert.equal(normal.trustedExecution, false);
    assert.throws(() => tasks.updateTask({ id: normal.id, trustedExecution: true, actor: 'agent' }), /Только пользователь/);
    assert.throws(() => tasks.createTask({ title: 'Escalation', trustedExecution: true, actor: 'agent' }), /Только пользователь/);
    const bounded = service.enqueue(normal.id);
    tasks.updateTask({ id: normal.id, trustedExecution: true, actor: 'user' });
    assert.equal(service.detail(bounded.id).run.trustedExecution, false, 'Existing snapshot cannot be escalated');
    service.cancel(bounded.id);
    const trusted = service.enqueue(normal.id);
    tasks.updateTask({ id: normal.id, trustedExecution: false, actor: 'user' });
    assert.equal(service.detail(trusted.id).run.trustedExecution, true, 'Checkbox applies only to new attempts');
    const run = service.claim('fixture')!, token = run.leaseToken!;
    const attempt = service.beginStage(run.id, token);
    assert.equal(tasks.getTaskCard(normal.id).status, 'planning');
    service.checkpoint(run.id, token, attempt, { key: 'a'.repeat(64), note: { summary: 'Локализовано изменение', implementationPlan: ['Изменить answer.ts и добавить регрессию', 'Прогнать focused unit test'], nextStep: 'Внести исправление' } });
    assert.equal(tasks.getTaskCard(normal.id).status, 'in_progress');
    assert.equal(tasks.getTaskCard(normal.id).plan?.version, 1);
    service.usage(run.id, token, attempt, { inputTokens: 100, outputTokens: 1, source: 'codex-json', reportedRequests: 1, missingRequests: 0 }, true);
    service.completeStage(run.id, token, { verdict: 'pass', summary: 'Implemented' }, `sat/${run.id}`, 'a'.repeat(40));
    service.beginStage(run.id, token); // Already above call and token caps.
    const revised = service.completeStage(run.id, token, { verdict: 'changes_requested', summary: 'Regression in behavior' }, `sat/${run.id}`, 'a'.repeat(40));
    assert.equal(revised.status, 'running'); assert.equal(revised.revision, 1, 'Revision cap is disabled');
    assert.equal(RunBudget.reason({ ...revised, budgetElapsedMs: 999999999 }, Date.now(), true), undefined);
    assert.equal(RunBudget.time(revised, Date.now()).disabled, true);
    service.cancel(run.id);
    assert.equal(service.detail(run.id).run.status, 'cancelled', 'Manual stop still works');
  } finally { app.close(); }
});
