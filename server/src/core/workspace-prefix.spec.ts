import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createContainer } from '../bootstrap/container.js';
import { createApiServer } from '../api/http-server.js';
import { SilentLogger } from './logger.js';

test('workspace prefix survives other process defaults, live edits and restart without renumbering', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-prefix-'));
  const options = { config: { appRoot: root, dbPath: path.join(root, 'data/tracker.db'), idPrefix: 'MS' }, logger: new SilentLogger() };
  const api = createContainer(options);
  let worker: ReturnType<typeof createContainer> | undefined;
  const server = createApiServer(api);
  try {
    const old = api.taskService.createTask({ title: 'Existing game task' });
    assert.match(old.id, /^MS-/);
    api.workspaceManager.create('tracker-team', 'Tracker', 'SAT');
    worker = createContainer({ ...options, config: { ...options.config, idPrefix: 'WRONG' } });
    const background = worker;
    assert.equal(background.config.idPrefix, 'MS');
    assert.match(background.taskService.createTask({ title: 'Worker task' }).id, /^MS-/);
    background.workspaceManager.within('tracker-team', () => assert.match(background.taskService.createTask({ title: 'Tracker task' }).id, /^SAT-/));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const edit = (prefix: unknown) => fetch(`${base}/api/workspaces/default/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Game', idPrefix: prefix }),
    });
    assert.equal((await edit(' game ')).status, 200);
    assert.equal((await (await fetch(`${base}/api/workspaces/default/prefix`)).json() as { idPrefix: string }).idPrefix, 'GAME');
    assert.equal(background.config.idPrefix, 'GAME', 'Already running worker observes persisted edits');
    assert.match(background.taskService.createTask({ title: 'New prefix' }).id, /^GAME-/);
    assert.equal(api.taskService.getTaskCard(old.id).id, old.id);
    for (const name of ['tracker-team', 'default', 'tracker-team']) {
      background.workspaceManager.within(name, () => assert.equal(background.config.idPrefix, name === 'tracker-team' ? 'SAT' : 'GAME'));
    }
    for (const prefix of ['', 'a-b', '1ABC', 'x'.repeat(21), null, 2]) assert.equal((await edit(prefix)).status, 400);
    assert.equal(api.workspaceManager.prefix('default'), 'GAME');
    assert.equal(api.workspaceManager.get('default').label, 'Game');
    worker.close(); worker = createContainer({ ...options, config: { ...options.config, idPrefix: 'OTHER' } });
    assert.equal(worker.config.idPrefix, 'GAME');
    assert.equal(worker.workspaceManager.prefix('tracker-team'), 'SAT');
  } finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    worker?.close(); api.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('legacy database recovers its existing task prefix rather than the first worker default', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-legacy-prefix-'));
  const options = { config: { appRoot: root, dbPath: path.join(root, 'data/tracker.db'), idPrefix: 'MS' }, logger: new SilentLogger() };
  let app = createContainer(options);
  try {
    const original = app.taskService.createTask({ title: 'Imported game task' });
    app.repos.meta.set('id_prefix', '');
    app.close(); app = createContainer({ ...options, config: { ...options.config, idPrefix: 'SAT' } });
    assert.equal(app.config.idPrefix, 'MS');
    assert.equal(app.taskService.getTaskCard(original.id).id, original.id);
    assert.match(app.taskService.createTask({ title: 'After import' }).id, /^MS-/);
  } finally { app.close(); rmSync(root, { recursive: true, force: true }); }
});
