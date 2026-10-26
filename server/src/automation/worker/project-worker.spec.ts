import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { ProjectWorker } from './project-worker.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { ProjectAction, ProjectRequestStatus, PROJECT_LIMITS, type ProjectRequest } from '../../../../shared/automation/project.js';
import { ProjectRequests } from '../project-requests.js';

test('host mailbox fences ownership and expires offline requests', async () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const registry = new TrackerToolRegistry(app);
    let now = Date.now();
    const mailbox = new ProjectRequests(app.repos.meta, app.db, () => now);
    const request = mailbox.enqueue({ action: ProjectAction.Browse, path: '' });
    assert.equal(mailbox.status().online, false);
    const claimed = mailbox.poll('host-1')!;
    assert.equal(mailbox.status().online, true);
    assert.equal(mailbox.get(request.id).token, undefined);
    assert.throws(() => mailbox.complete(request.id, 'wrong', { path: 'no' }), /другому worker/);
    assert.equal(mailbox.poll('host-2'), null);
    mailbox.complete(request.id, claimed.token!, { path: 'ok' });
    assert.equal(mailbox.get(request.id).status, ProjectRequestStatus.Completed);
    const offline = mailbox.enqueue({ action: ProjectAction.Inspect, path: '/missing' });
    now += PROJECT_LIMITS.requestMs + 1;
    assert.equal(mailbox.get(offline.id).status, ProjectRequestStatus.Failed);
    assert.equal(mailbox.poll('host-1'), null, 'Expired request cannot run later');
    assert.ok(registry.definitions().some((entry) => entry.name.endsWith('host_complete') && 'result' in (entry.inputSchema.properties ?? {})));
  } finally { app.close(); }
});

test('host worker browses folders, reads branches/scripts and creates branch without checkout or overwriting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-host-project-'));
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const repo = path.join(root, 'project with spaces'); await mkdir(repo);
    const executor = new ProcessExecutor();
    const git = (args: string[]) => executor.run({ command: 'git', args, cwd: repo, signal: AbortSignal.timeout(30000) });
    await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'build:web': 'echo build' } }));
    await git(['add', '.']); await git(['commit', '-m', 'initial']);
    const registry = new TrackerToolRegistry(app);
    const worker = new ProjectWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const response = await registry.call(name, args);
      const text = response.content.filter((entry) => entry.type === 'text').map((entry) => entry.type === 'text' ? entry.text : '').join('');
      if (response.isError) throw new Error(text); return JSON.parse(text) as T;
    } }, 'fixture-host');
    const pickerWorker = new ProjectWorker({ async call<T>(): Promise<T> { throw new Error('not called'); } }, 'picker-fixture', { async pick() { return repo; } });
    assert.equal((await pickerWorker.execute({ action: ProjectAction.PickFolder, path: '' })).path, repo);
    const cancelledWorker = new ProjectWorker({ async call<T>(): Promise<T> { throw new Error('not called'); } }, 'picker-fixture', { async pick() { return null; } });
    assert.deepEqual(await cancelledWorker.execute({ action: ProjectAction.PickFolder, path: 'keep-this' }), { path: 'keep-this', cancelled: true });
    const request = app.automationService.projects.enqueue({ action: ProjectAction.Browse, path: root }); await worker.tick();
    assert.ok(app.automationService.projects.get(request.id).result!.directories!.some((entry) => entry.name === 'project with spaces'));
    const inspected = await worker.execute({ action: ProjectAction.Inspect, path: repo });
    assert.deepEqual(inspected.branches, ['main']); assert.deepEqual(inspected.scripts, ['test', 'build:web']);
    const create = app.automationService.projects.enqueue({ action: ProjectAction.CreateBranch, path: repo, baseBranch: 'main', newBranch: 'feature/selected' });
    await worker.tick();
    const result = app.automationService.projects.get(create.id);
    assert.equal(result.status, ProjectRequestStatus.Completed);
    assert.ok(result.result!.branches!.includes('feature/selected'));
    assert.equal((await git(['branch', '--show-current'])).trim(), 'main');
    await assert.rejects(worker.execute({ action: ProjectAction.CreateBranch, path: repo, baseBranch: 'main', newBranch: 'feature/selected' }));
    await assert.rejects(worker.execute({ action: ProjectAction.CreateBranch, path: repo, baseBranch: '--help', newBranch: 'bad' }));
    await assert.rejects(worker.execute({ action: ProjectAction.Inspect, path: root }));
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
