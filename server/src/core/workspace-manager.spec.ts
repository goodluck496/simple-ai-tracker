import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from './logger.js';
import { createApiServer } from '../api/http-server.js';
import type { AddressInfo } from 'node:net';
import { TrackerToolRegistry } from '../mcp/tools.js';

test('workspace services follow A/B/A and preserve separate tasks with identical IDs', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-workspaces-'));
  const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'),
    imagesDir: path.join(root, 'data', 'images'), backupDir: path.join(root, 'data', 'backups') }, logger: new SilentLogger() });
  try {
    const first = app.taskService.createTask({ title: 'Default task' });
    const originalImages = app.config.imagesDir;
    app.workspaceManager.create('second');
    app.workspaceManager.activate('second');
    assert.deepEqual(app.taskService.listTasks({}), []);
    const second = app.taskService.createTask({ title: 'Second task' });
    assert.equal(first.id, second.id);
    assert.notEqual(app.config.imagesDir, originalImages);
    app.workspaceManager.activate('default');
    assert.equal(app.taskService.listTasks({})[0].title, 'Default task');
    assert.equal(app.config.imagesDir, originalImages);
    app.workspaceManager.activate('second');
    assert.equal(app.taskService.listTasks({})[0].title, 'Second task');
    await Promise.all(['default', 'second'].map((name) => app.workspaceManager.within(name, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(app.taskService.listTasks({})[0].title, name === 'default' ? 'Default task' : 'Second task');
    })));
    const server = createApiServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const name of ['default', 'second', 'default']) {
        const response = await fetch(`${base}/api/tasks`, { headers: { 'X-Tracker-Workspace': name } });
        assert.equal(response.status, 200);
        const payload = await response.json() as { tasks: { title: string }[] };
        assert.equal(payload.tasks[0].title, name === 'default' ? 'Default task' : 'Second task');
      }
      assert.equal((await fetch(`${base}/api/tasks`, { headers: { 'X-Tracker-Workspace': 'unknown' } })).status, 404);
      const registry = new TrackerToolRegistry(app);
      const result = await registry.call('tracker_list_tasks', {});
      assert.match(JSON.stringify(result), /Default task/);
      assert.doesNotMatch(JSON.stringify(result), /Second task/);
      const explicit = await registry.call('tracker_list_tasks', { workspace: 'second' });
      assert.match(JSON.stringify(explicit), /Second task/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('in-memory containers retain injected clock and database without using the registry', () => {
  const app = createContainer({ config: { dbPath: ':memory:' },
    clock: { now: () => '2026-01-01T00:00:00.000Z' }, logger: new SilentLogger() });
  try {
    assert.equal(app.taskService.createTask({ title: 'Isolated task' }).createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(app.workspaceManager.currentName, 'default');
  } finally { app.close(); }
});
