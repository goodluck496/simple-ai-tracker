import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { RunBudget } from '../../../shared/automation/budget.js';

function exampleSettings(): AutomationSettings {
  return { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'native', label: 'Fixture', kind: 'native', supportsImages: false }],
    agents: (['analyst', 'developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role,
      runner: 'codex', connectionId: 'native', model: 'fixture', instructions: '' })),
    pipeline: ['analyst', 'developer', 'tester', 'reviewer'], checks: [{ command: 'node', args: ['--version'] }] };
}

test('run budgets survive resume, include cached input once, and fence new agent calls', () => {
  let now = '2026-10-25T00:00:00.000Z';
  const app = createContainer({ config: { dbPath: ':memory:' }, clock: { now: () => now }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure({ ...exampleSettings(), maxAgentCalls: 1, maxInputTokens: 100, maxRunMinutes: 1 });
    const task = app.taskService.createTask({ title: 'Budget fixture' });
    const queued = service.enqueue(task.id);
    const run = service.claim('worker')!;
    const attempt = service.beginStage(run.id, run.leaseToken!);
    service.usage(run.id, run.leaseToken!, attempt, { inputTokens: 99, cachedInputTokens: 90, outputTokens: 1,
      source: 'codex-json', reportedRequests: 1, missingRequests: 0 }, true);
    assert.equal(RunBudget.reason(service.detail(run.id).run, Date.parse(now)), undefined);
    now = '2026-10-25T00:00:30.000Z';
    service.fail(run.id, run.leaseToken!, 'fixture infrastructure failure');
    assert.equal(service.detail(run.id).run.budgetElapsedMs, 30000);
    assert.equal(service.detail(run.id).item.status, 'failed', 'selected detail must reflect terminal status after leaving active queue');
    assert.equal(service.detail(run.id).item.canResume, true);
    assert.equal(service.queue(false).items.length, 0);
    now = '2026-10-26T00:00:00.000Z';
    assert.deepEqual(RunBudget.time(service.detail(run.id).run, Date.parse(now)), { disabled: false, usedMs: 30000, limitMs: 60000, remainingMs: 30000 });
    service.resume(queued.id);
    const resumed = service.claim('worker-2')!;
    assert.equal(resumed.budgetElapsedMs, 30000, 'waiting time does not consume active budget');
    assert.throws(() => service.beginStage(run.id, resumed.leaseToken!), /agent call limit/);
    now = '2026-10-26T00:00:30.000Z';
    service.heartbeat(run.id, resumed.leaseToken!);
    assert.equal(service.detail(run.id).run.budgetElapsedMs, 30000, 'resumed preparation is not agent time');
    assert.equal(service.detail(run.id).run.usageAttempts!.length, 1);
  } finally { app.close(); }
});

test('only agent execution consumes time across preparation, checks and resume', () => {
  let milliseconds = Date.parse('2026-10-30T00:00:00Z');
  const app = createContainer({ config: { dbPath: ':memory:' }, clock: { now: () => new Date(milliseconds).toISOString() }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure({ ...exampleSettings(), maxRunMinutes: 1 });
    const task = app.taskService.createTask({ title: 'Agent execution clock' });
    service.enqueue(task.id);
    let run = service.claim('worker')!;
    const advance = (seconds: number) => { milliseconds += seconds * 1000; };
    for (const phase of ['preparing', 'waiting-slot', 'setup'] as const) {
      service.progress(run.id, run.leaseToken!, 'Administrative work', phase);
      advance(30);
      service.heartbeat(run.id, run.leaseToken!);
      assert.equal(service.detail(run.id).run.budgetElapsedMs, 0);
    }
    service.beginStage(run.id, run.leaseToken!);
    advance(20);
    service.progress(run.id, run.leaseToken!, 'Agent returned', 'checks');
    advance(30);
    service.heartbeat(run.id, run.leaseToken!);
    assert.equal(service.detail(run.id).run.budgetElapsedMs, 20000);
    service.fail(run.id, run.leaseToken!, 'Infrastructure stopped');
    advance(60);
    service.resume(run.id);
    run = service.claim('worker')!;
    advance(30);
    service.heartbeat(run.id, run.leaseToken!);
    service.beginStage(run.id, run.leaseToken!);
    advance(40);
    assert.throws(() => service.heartbeat(run.id, run.leaseToken!), /active time limit/);
    service.fail(run.id, run.leaseToken!, 'Time budget exhausted');
    assert.equal(service.detail(run.id).run.budgetElapsedMs, 60000);
    assert.throws(() => service.resume(run.id), /active time limit/);
  } finally { app.close(); }
});

test('token budget blocks new calls at exact boundary and blocked verdict never loops developer', () => {
  for (const verdict of ['blocked', 'changes_requested'] as const) {
    const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
    try {
      const service = app.automationService;
      service.configure({ ...exampleSettings(), pipeline: ['developer', 'tester', 'reviewer'], maxInputTokens: 100 });
      const task = app.taskService.createTask({ title: verdict });
      app.taskService.attachPlan({ id: task.id, planContent: '# Fixture plan', actor: 'agent' });
      service.enqueue(task.id);
      const run = service.claim('fixture')!; const token = run.leaseToken!;
      const attempt = service.beginStage(run.id, token);
      if (verdict === 'blocked') {
        service.usage(run.id, token, attempt, { inputTokens: 100, cachedInputTokens: 100, outputTokens: 0,
          source: 'codex-json', reportedRequests: 1, missingRequests: 0 }, true);
        assert.throws(() => service.beginStage(run.id, token), /input token limit/);
      }
      const result = service.completeStage(run.id, token, { verdict, summary: 'Docker access denied' }, `sat/${run.id}`, 'a'.repeat(40));
      assert.equal(result.status, 'failed'); assert.equal(result.revision, 0);
      assert.ok(service.detail(run.id).events.some(e => e.kind === 'failed'));
    } finally { app.close(); }
  }
});
