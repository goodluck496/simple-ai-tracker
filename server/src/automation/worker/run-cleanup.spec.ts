import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProcessExecutor } from '../runners/process-executor.js';
import { RunWorkspace } from './run-workspace.js';
import { RunCleanup } from './run-cleanup.js';
import { RuntimeCoordinator } from './runtime-coordinator.js';
import type { CleanupSpec } from '../../../../shared/automation/cleanup.js';

test('cleanup fences paths, unmerged/dirty state and removes junctions without following their targets', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-cleanup-'));
  const repository = path.join(temporary, 'source'); await fs.mkdir(repository);
  const executor = new ProcessExecutor(); const signal = AbortSignal.timeout(30000);
  const git = (args: string[]) => executor.run({ command: 'git', args, cwd: repository, signal });
  try {
    await git(['init', '-b', 'master']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(repository, 'source.txt'), 'original'); await git(['add', '.']); await git(['commit', '-m', 'fixture']);
    const sourceSha = (await git(['rev-parse', 'HEAD'])).trim();
    const location = await RunWorkspace.describe(repository, 'cleanup-fixture', 'test', executor, signal);
    await fs.appendFile(path.join(location.common, 'info', 'exclude'), '\n/node_modules/\n');
    await fs.mkdir(path.dirname(location.directory), { recursive: true });
    await git(['worktree', 'add', '-b', location.branch, location.directory]);
    const shared = path.join(temporary, 'shared-cache'); await fs.mkdir(shared); await fs.writeFile(path.join(shared, 'keep.txt'), 'keep');
    await fs.symlink(shared, path.join(location.directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const spec: CleanupSpec = { runId: 'cleanup-fixture', workspace: 'test', repository, directory: location.directory, baseBranch: 'master', sourceSha, children: [], merged: false, discard: false };
    const cleanup = new RunCleanup(executor);
    const coordinator = new RuntimeCoordinator(path.join(location.common, 'sat-runtime', 'coordination.sqlite'));
    const held = await coordinator.acquire('run:cleanup-fixture', signal);
    try { await assert.rejects(cleanup.execute({ ...spec, discard: true }, AbortSignal.timeout(1000)), /abort|timed out/i); }
    finally { held.release(); coordinator.close(); }
    await assert.rejects(cleanup.execute(spec, signal), /explicit discard/);
    await assert.rejects(cleanup.execute({ ...spec, discard: true, directory: repository }, signal), /managed workspace/);
    await fs.writeFile(path.join(location.directory, 'source.txt'), 'unmerged edits');
    await assert.rejects(cleanup.execute({ ...spec, merged: true, candidateSha: sourceSha }, signal), /Dirty/);
    assert.equal(await fs.readFile(path.join(location.directory, 'source.txt'), 'utf8'), 'unmerged edits');
    await git(['-C', location.directory, 'branch', '-m', 'foreign-retained']);
    await assert.rejects(cleanup.execute({ ...spec, discard: true }, signal), /identity changed|renamed/);
    await git(['-C', location.directory, 'branch', '-m', location.branch]);
    await git(['-C', location.directory, 'add', 'source.txt']); await git(['-C', location.directory, 'commit', '-m', 'changed after review']);
    await assert.rejects(cleanup.execute({ ...spec, merged: true, candidateSha: sourceSha }, signal), /changed after review/);
    const result = await cleanup.execute({ ...spec, discard: true }, signal);
    assert.ok(result.paths.includes(location.directory)); assert.ok(result.branches.includes(location.branch));
    await assert.rejects(fs.stat(location.directory), /ENOENT/);
    assert.equal(await fs.readFile(path.join(shared, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(repository, 'source.txt'), 'utf8'), 'original');
    assert.deepEqual((await cleanup.execute({ ...spec, discard: true }, signal)).paths, [], 'Cleanup is safe to retry');
    const automatic = await RunWorkspace.describe(repository, 'merged-fixture', 'test', executor, signal);
    await git(['worktree', 'add', '-b', automatic.branch, automatic.directory]);
    const integrationBranch = 'sat-integration/merged-fixture-1';
    await git(['worktree', 'add', '-b', integrationBranch, `${automatic.directory}-integration-1`]);
    const done = await cleanup.execute({ ...spec, runId: 'merged-fixture', directory: automatic.directory, merged: true, candidateSha: sourceSha }, signal);
    assert.ok(done.branches.includes(automatic.branch), 'Verified merged source branches are removed without discard');
    assert.ok(done.branches.includes(integrationBranch), 'Verified integration branches are removed too');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
