import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProcessExecutor } from '../runners/process-executor.js';
import { StageCheckpoint } from './stage-checkpoint.js';

test('worktree integrity ignores Git-equivalent line endings and detects real edits to dirty files', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-integrity-'));
  try {
    const executor = new ProcessExecutor();
    const signal = AbortSignal.timeout(30000);
    const git = (args: string[]) => executor.run({ command: 'git', args: ['-c', 'core.autocrlf=true', ...args], cwd, signal });
    const source = path.join(cwd, 'generated.ts');
    await git(['init', '-q']);
    await fs.writeFile(source, 'export const icon = 1;\r\n');
    await git(['add', 'generated.ts']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
    const checkpoint = new StageCheckpoint(cwd, 0, 0, git);
    const baseline = await checkpoint.fingerprint();
    await fs.writeFile(source, 'export const icon = 1;\n');
    assert.equal(await checkpoint.fingerprint(), baseline);
    assert.equal(await checkpoint.isClean(), true);
    await fs.writeFile(source, 'export const icon = 2;\n');
    const dirty = await checkpoint.fingerprint();
    assert.notEqual(dirty, baseline);
    await fs.writeFile(source, 'export const icon = 3;\n');
    assert.notEqual(await checkpoint.fingerprint(), dirty);
    assert.equal(await checkpoint.isClean(), false);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
