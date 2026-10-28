import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createContainer } from '../bootstrap/container.js';
import { createApiServer } from '../api/http-server.js';
import { SilentLogger } from './logger.js';

test('rename workspace label persists through restart without changing IDs, storage, tasks or active context', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-rename-'));
  const options = { config: { appRoot: root, dbPath: path.join(root, 'data/tracker.db') }, logger: new SilentLogger() };
  let app = createContainer(options);
  const server = createApiServer(app);
  try {
    const manager = app.workspaceManager;
    const original = manager.get('default');
    const task = app.taskService.createTask({ title: 'Preserved task' });
    const second = manager.create('second', 'Second');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const rename = (name: string, label: unknown) => fetch(base + '/api/workspaces/' + name + '/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    });
    const response = await rename('default', '  Моё пространство  ');
    assert.equal(response.status, 200);
    assert.deepEqual(manager.get('default'), { ...original, label: 'Моё пространство' });
    assert.equal(manager.currentName, 'default');
    assert.equal(app.taskService.getTaskCard(task.id).title, 'Preserved task');
    assert.equal((await rename('second', 'Другой проект')).status, 200);
    assert.deepEqual(manager.get('second'), { ...second, label: 'Другой проект' });
    for (const label of ['', '   ', 'x'.repeat(101), 'bad\nlabel', 5, null]) assert.ok((await rename('second', label)).status >= 400);
    assert.equal((await rename('missing', 'Missing')).status, 404);
    assert.equal(manager.get('second').label, 'Другой проект');
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.close(); app = createContainer(options);
    assert.deepEqual(app.workspaceManager.get('default'), { ...original, label: 'Моё пространство' });
    assert.equal(app.taskService.getTaskCard(task.id).title, 'Preserved task');
    assert.deepEqual(app.workspaceManager.get('second'), { ...second, label: 'Другой проект' });
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    app.close(); rmSync(root, { recursive: true, force: true });
  }
});
