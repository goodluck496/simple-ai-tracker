import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../../../shared/automation/presets.js';

test('history, cleanup acknowledgement, discard and permanent delete preserve the task', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
      agents: STANDARD_TEAM_ROLES.map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })), pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] });
    const task = app.taskService.createTask({ title: 'Cleanup fixture' });
    const run = service.enqueue(task.id); const owned = service.claim('worker')!;
    assert.throws(() => service.cleanup(run.id, true), /остановите/);
    assert.throws(() => service.deleteRun(run.id), /Активный/);
    service.checkout(run.id, owned.leaseToken!, { repositoryRoot: '/fixture', worktreePath: `/work/.sat-worktrees/project/test/${run.id}`, baseSha: 'a'.repeat(40), dependencyMode: 'isolated' });
    service.fail(run.id, owned.leaseToken!, 'fixture failure');
    assert.equal(service.queue(false).items.length, 0);
    service.hide(run.id);
    assert.equal(service.queue(true, task.id).items[0].id, run.id, 'Archived runs remain in task history');
    assert.throws(() => service.cleanup(run.id), /Подтвердите/);
    assert.throws(() => service.deleteRun(run.id), /Сначала очистите/);
    const pending = service.cleanup(run.id, true);
    assert.equal(pending.state, 'queued');
    assert.throws(() => service.resume(run.id), /очищается/);
    const request = service.projects.poll('host')!;
    assert.throws(() => service.completeHost(request.id, 'wrong', { path: '' }), /другому/);
    service.completeHost(request.id, request.token!, undefined, 'locked by process');
    assert.equal(service.detail(run.id).run.cleanup?.state, 'failed');
    assert.throws(() => service.deleteRun(run.id), /очистите/);
    service.cleanup(run.id, true);
    const expired = service.projects.poll('host')!;
    const state = JSON.parse(app.repos.meta.get('automation_host_requests_v1')!);
    state.requests.find((entry: { id: string }) => entry.id === expired.id).createdAt = 0;
    app.repos.meta.set('automation_host_requests_v1', JSON.stringify(state));
    assert.equal(service.queue(true, task.id).items[0].cleanup?.state, 'failed', 'An offline cleanup must become retryable in the UI');
    service.cleanup(run.id, true);
    const retry = service.projects.poll('host')!;
    service.completeHost(retry.id, retry.token!, { path: '/fixture', cleanup: { paths: ['owned'], branches: ['sat/fixture'], retainedBranches: [] } });
    assert.equal(service.detail(run.id).run.cleanup?.state, 'completed');
    service.deleteRun(run.id); service.deleteRun(run.id);
    assert.equal(service.queue(true, task.id).items.length, 0);
    assert.equal(app.taskService.getTaskCard(task.id).title, 'Cleanup fixture');
  } finally { app.close(); }
});
