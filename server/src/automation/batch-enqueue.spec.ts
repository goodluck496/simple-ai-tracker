import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { TrackerToolRegistry } from '../mcp/tools.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';

test('batch enqueue is atomic, bounded, immutable and idempotent through MCP', async () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    const settings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
      connections: [{ id: 'n', label: 'Native', kind: 'native' as const, supportsImages: false }],
      agents: (['analyst', 'developer'] as const).map(role => ({ id: role, role, runner: 'codex' as const, connectionId: 'n', model: 'fixture', instructions: '' })),
      pipeline: ['analyst', 'developer'], checks: [{ command: 'npm', args: ['test'] }] };
    service.configure(settings);
    const a = app.taskService.createTask({ title: 'A' }); const b = app.taskService.createTask({ title: 'B' });
    const blocked = app.taskService.createTask({ title: 'Blocked' });
    app.taskService.askQuestions({ id: blocked.id, questions: ['Why?'], actor: 'agent' });
    const analysis = { ...settings, pipeline: ['analyst'], checks: [] };
    assert.throws(() => service.enqueueBatch([a.id, blocked.id], analysis), /Ни одна задача/);
    assert.equal(service.list().length, 0);
    for (const ids of [[], [a.id, a.id], Array(51).fill(a.id), [5], 'bad']) assert.throws(() => service.enqueueBatch(ids, analysis), /разных задач/);
    assert.throws(() => service.enqueueBatch([a.id, b.id], { ...settings, pipeline: ['developer'] }), /plan|analyst/);
    assert.equal(service.list().length, 0);
    const registry = new TrackerToolRegistry(app); const requestId = randomUUID();
    const response = await registry.call('tracker_automation_enqueue_batch', { taskIds: [a.id, b.id], settings: analysis, requestId });
    assert.equal(response.isError, undefined);
    const runs = service.list(); assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.settings.pipeline.join() === 'analyst' && run.settings.checks.length === 0));
    assert.deepEqual(service.settings(), settings, 'Group snapshot cannot overwrite project defaults');
    const repeated = service.enqueueBatch([a.id, b.id], analysis, requestId);
    assert.deepEqual(repeated.map(r => r.id).sort(), runs.map(r => r.id).sort());
    assert.equal(service.list().length, 2);
    assert.throws(() => service.enqueueBatch([a.id], analysis, requestId), /другим составом/);
    const c = app.taskService.createTask({ title: 'C' });
    assert.throws(() => service.enqueueBatch([c.id, a.id], analysis), /Ни одна задача/);
    assert.equal(service.list(c.id).length, 0, 'An active duplicate rolls back earlier new runs');
    assert.throws(() => service.enqueueBatch([c.id, 'MISSING-9'], analysis), /Ни одна задача/);
    assert.equal(service.list(c.id).length, 0);
    for (let i = 0; i < 2; i++) {
      const owned = service.claim('fixture')!; service.beginStage(owned.id, owned.leaseToken!);
      service.completeStage(owned.id, owned.leaseToken!, { verdict: 'pass', summary: 'Plan', plan: '# Plan' }, 'sat/fixture', 'a'.repeat(40));
    }
    assert.equal(service.enqueueBatch([a.id, b.id], analysis, requestId).length, 2, 'Same request remains idempotent after analysis completes');
    assert.equal(service.list().length, 2);
  } finally { app.close(); }
});
