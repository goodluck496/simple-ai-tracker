import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { ProjectAction } from '../../../shared/automation/project.js';

test('worker controls reject offline/legacy hosts and fence commands to the owning supervisor', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const projects = app.automationService.projects;
    assert.throws(() => projects.enqueue({ action: ProjectAction.StartWorker, path: '' }), /не подключён/);
    projects.poll('legacy', 'win32');
    assert.throws(() => projects.enqueue({ action: ProjectAction.StartWorker, path: '' }), /Старый worker/);
    projects.poll('supervisor', 'win32', { state: 'stopped' });
    const first = projects.enqueue({ action: ProjectAction.StartWorker, path: '' });
    assert.equal(projects.enqueue({ action: ProjectAction.StartWorker, path: '' }).id, first.id);
    assert.equal(projects.poll('other-host', 'win32', { state: 'stopped' }), null);
    const claimed = projects.poll('supervisor', 'win32', { state: 'stopped' })!;
    assert.equal(projects.status().execution?.state, 'starting');
    assert.throws(() => projects.complete(first.id, 'wrong', { path: '', execution: { state: 'running' } }), /другому/);
    projects.complete(first.id, claimed.token!, { path: '', execution: { state: 'running', pid: 123 } });
    assert.equal(projects.status().execution?.state, 'running');
    const stop = projects.enqueue({ action: ProjectAction.StopWorker, path: '' });
    assert.equal(projects.status().executionDesired, false, 'Stop intent is durable before acknowledgement');
    const stopped = projects.poll('supervisor', 'win32', { state: 'running' })!;
    projects.complete(stop.id, stopped.token!, { path: '', execution: { state: 'stopped' } });
    assert.equal(projects.status().online, true); assert.equal(projects.status().execution?.state, 'stopped');
  } finally { app.close(); }
});
