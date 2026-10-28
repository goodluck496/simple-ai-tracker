import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProcessExecutor } from './process-executor.js';
import { WorktreePermissions } from './worktree-permissions.js';
import { NativeAgentRunner } from './native-runner.js';
import type { AgentJob } from '../../../../shared/automation/contracts.js';

test('YOLO requires a real registered linked worktree of the configured repository before any model call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-permission-'));
  const executor = new ProcessExecutor(); const signal = AbortSignal.timeout(30000);
  const git = (cwd: string, args: string[]) => executor.run({ command: 'git', args, cwd, signal });
  try {
    for (const name of ['a', 'b']) {
      const cwd = path.join(root, name); await fs.mkdir(cwd);
      await git(cwd, ['init', '-b', 'main']); await git(cwd, ['config', 'user.name', 'Fixture']); await git(cwd, ['config', 'user.email', 'fixture@example.invalid']);
      await fs.writeFile(path.join(cwd, 'README.md'), 'fixture'); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'fixture']);
      await git(cwd, ['worktree', 'add', '-b', 'fixture', path.join(root, 'wt-' + name)]);
    }
    const repository = path.join(root, 'a'); const cwd = path.join(root, 'wt-a');
    const job = { cwd, settings: { repositoryPath: repository }, signal } as AgentJob;
    await new WorktreePermissions().verify(job);
    await assert.rejects(new WorktreePermissions().verify({ ...job, cwd: repository }), /основном checkout/);
    await assert.rejects(new WorktreePermissions().verify({ ...job, cwd: path.join(root, 'wt-b') }), /другому репозиторию/);
    const fake = path.join(root, 'fake'); await fs.mkdir(fake); await fs.copyFile(path.join(cwd, '.git'), path.join(fake, '.git'));
    await assert.rejects(new WorktreePermissions().verify({ ...job, cwd: fake }), /не зарегистрирована/);
    let modelCalls = 0;
    class Model extends ProcessExecutor { public override async run() { modelCalls++; return ''; } }
    await assert.rejects(new NativeAgentRunner('antigravity', new Model()).run({ ...job, cwd: repository }, () => {}), /основном checkout/);
    assert.equal(modelCalls, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
