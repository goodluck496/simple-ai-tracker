import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { RunPhase } from '../../../shared/automation/queue.js';

function fixture() {
  let time = Date.parse('2026-10-27T00:00:00Z');
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger(), clock: { now: () => new Date(time).toISOString() } });
  const service = app.automationService;
  service.configure({ ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: '/fixture', baseBranch: 'master', mergePolicy: 'local', maxRunMinutes: 1,
    connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
    agents: (['developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'codex', model: 'fixture', instructions: '', connectionId: 'fixture' })),
    pipeline: ['developer', 'tester', 'reviewer'], checks: [{ command: 'node', args: ['--version'] }] });
  const task = app.taskService.createTask({ title: 'Integration fixture' });
  app.taskService.attachPlan({ id: task.id, planContent: '# Fixture', actor: 'agent' });
  const run = service.enqueue(task.id); const claimed = service.claim('fixture')!; const token = claimed.leaseToken!;
  const finish = () => {
    for (let i = 0; i < 3; i++) {
      const attempt = service.beginStage(run.id, token); service.usage(run.id, token, attempt, undefined, true);
      service.completeStage(run.id, token, { verdict: 'pass', summary: 'checked', commitMessage: `[#${task.id}] - Изменено поведение задачи, чтобы проверить интеграцию` }, `sat/${run.id}`, 'a'.repeat(40));
    }
  };
  return { app, service, task, run, token, finish, advance: (ms: number) => { time += ms; } };
}

test('integration keeps its lease, fences publication cancellation and acknowledges a verified SHA after the budget deadline', () => {
  const f = fixture();
  try {
    assert.equal(f.run.startedAt, undefined);
    assert.equal(f.service.detail(f.run.id).run.startedAt, '2026-10-27T00:00:00.000Z');
    assert.equal(f.service.detail(f.run.id).run.finishedAt, undefined);
    f.finish(); assert.equal(f.service.detail(f.run.id).run.status, 'integrating');
    assert.equal(f.service.detail(f.run.id).run.finishedAt, undefined);
    f.service.beginStage(f.run.id, f.token, true);
    f.advance(60000);
    f.service.heartbeat(f.run.id, f.token, true);
    const info = { state: 'publishing' as const, sourceSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), candidateSha: 'c'.repeat(40), targetBranch: 'master', worktreePath: '/fixture-integration', attempt: 1 };
    f.service.integration(f.run.id, f.token, info);
    assert.throws(() => f.service.cancel(f.run.id), /publication/);
    f.advance(5000);
    assert.throws(() => f.service.heartbeat(f.run.id, f.token), /budget/);
    f.service.heartbeat(f.run.id, f.token, false, true);
    assert.throws(() => f.service.beginStage(f.run.id, f.token, true), /budget/);
    f.service.merged(f.run.id, f.token);
    assert.equal(f.service.detail(f.run.id).run.status, 'merged');
    assert.equal(f.service.detail(f.run.id).run.finishedAt, '2026-10-27T00:01:05.000Z');
    assert.ok(f.service.detail(f.run.id).run.summary.includes(info.candidateSha), 'Final summary must describe publication instead of a stale interruption');
    assert.equal(f.app.taskService.getTaskCard(f.task.id).status, 'review');
    assert.ok(f.service.detail(f.run.id).events.some(e => e.kind === 'merged' && e.text.includes(info.candidateSha)));
  } finally { f.app.close(); }
});

test('blocked merge resumes integration only, explicit restart preserves reviewed source and resolver calls are bounded', () => {
  const f = fixture();
  try {
    f.finish(); const attempt = f.service.beginStage(f.run.id, f.token, true); f.service.usage(f.run.id, f.token, attempt, undefined, true);
    assert.throws(() => f.service.beginStage(f.run.id, f.token, true), /resolver call budget/);
    f.service.fail(f.run.id, f.token, 'resolver blocked');
    assert.equal(f.service.detail(f.run.id).run.status, 'merge_blocked');
    assert.ok(f.service.detail(f.run.id).run.finishedAt);
    f.service.resume(f.run.id); const resumed = f.service.claim('second')!;
    assert.equal(resumed.status, 'integrating'); assert.equal(resumed.stage, 3);
    assert.equal(resumed.startedAt, '2026-10-27T00:00:00.000Z');
    assert.equal(resumed.finishedAt, undefined);
    assert.throws(() => f.service.beginStage(resumed.id, resumed.leaseToken!), /phase/);
    f.service.fail(resumed.id, resumed.leaseToken!, 'still blocked');
    const restarted = f.service.restart(resumed.id);
    assert.equal(restarted.integrationSourceSha, 'a'.repeat(40)); assert.equal(restarted.stage, 3);
    assert.notEqual(restarted.id, resumed.id);
    assert.equal(restarted.startedAt, undefined); assert.equal(restarted.finishedAt, undefined);
    assert.equal(restarted.usageAttempts!.length, 0); assert.equal(restarted.restartedFromId, f.run.id);
    assert.equal(f.service.claim('third')!.status, 'integrating');
  } finally { f.app.close(); }
});

test('waiting for repository capacity pauses the active budget and expired integration leases recover without pipeline replay', () => {
  const f = fixture();
  try {
    f.service.progress(f.run.id, f.token, 'waiting', RunPhase.WaitingSlot);
    for (let i = 0; i < 3; i++) { f.advance(60000); f.service.heartbeat(f.run.id, f.token); }
    assert.equal(f.service.detail(f.run.id).run.budgetElapsedMs, 0);
    f.service.progress(f.run.id, f.token, 'ready', RunPhase.Preparing); f.finish();
    f.advance(91000); assert.equal(f.service.detail(f.run.id).run.status, 'merge_blocked');
    f.service.resume(f.run.id); const recovery = f.service.claim('recovery')!;
    assert.equal(recovery.stage, 3); f.service.heartbeat(recovery.id, recovery.leaseToken!, true);
    assert.throws(() => f.service.beginStage(recovery.id, recovery.leaseToken!, true), /budget/);
  } finally { f.app.close(); }
});
