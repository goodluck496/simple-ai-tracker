import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { projectCommand } from '../../../shared/automation/project.js';
import { assertProjectCheckScripts, readProjectPackageManager } from './package-manager.js';
import { ProcessExecutor, type ProcessRequest } from './runners/process-executor.js';
import { WorktreePreparation } from './worker/worktree-preparation.js';
import { PostOperationRunner } from './worker/post-operation-runner.js';

test('dependency inspection accepts asset and CLI packages and detects missing declared files', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-dependency-inspect-'));
  try {
    const packages = {
      icons: { files: ['icons.css'] },
      cli: { main: 'index.js', bin: { cli: './cli.js' }, files: ['cli.js'] },
      'broken-cli': { bin: './missing.js' },
      'broken-library': { main: './missing.js' },
      'broken-export': { exports: { import: './missing.mjs', require: './missing.cjs' } },
    };
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: Object.fromEntries([...Object.keys(packages), 'missing-package'].map(name => [name, '1.0.0'])),
    }));
    for (const [name, manifest] of Object.entries(packages)) {
      const directory = path.join(cwd, 'node_modules', name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, ...manifest }));
      for (const file of 'files' in manifest ? manifest.files : []) await fs.writeFile(path.join(directory, file), '');
    }
    assert.deepEqual(await new WorktreePreparation(new ProcessExecutor()).inspect(cwd),
      ['broken-cli', 'broken-library', 'broken-export', 'missing-package']);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('saved npm commands resolve to pnpm without losing script arguments or post-operation options', () => {
  const pnpm = { packageManager: 'pnpm', hasLockfile: true } as const;
  assert.deepEqual(projectCommand({ command: 'npm', args: ['ci', '--include=dev', '--no-audit', '--ignore-scripts'] }, pnpm),
    { command: 'pnpm', args: ['install', '--frozen-lockfile', '--prod=false', '--ignore-scripts'] });
  assert.deepEqual(projectCommand({ command: 'npm.cmd', args: ['run', 'build', '--', '--target', 'a b'], background: true }, pnpm),
    { command: 'pnpm', args: ['run', 'build', '--target', 'a b'], background: true });
  assert.deepEqual(projectCommand({ command: 'npm', args: ['test'] }, pnpm), { command: 'pnpm', args: ['run', 'test'] });
  assert.throws(() => projectCommand({ command: 'npm', args: ['install', 'some-package'] }, pnpm), /эквивалентную команду pnpm/);
});

test('pnpm lock selects isolated pnpm setup, invalidates it when the workspace changes and translates post-operations', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-pnpm-'));
  try {
    const signal = AbortSignal.timeout(20000);
    const calls: { command: string; args: string[] }[] = [];
    class RecordingExecutor extends ProcessExecutor {
      public override run(request: ProcessRequest): Promise<string> {
        if (request.command === 'git') return super.run(request);
        calls.push({ command: request.command, args: request.args });
        return Promise.resolve('');
      }
    }
    const executor = new RecordingExecutor();
    const git = (args: string[]) => executor.run({ command: 'git', args, cwd, signal });
    await git(['init', '-q']);
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'node build.js' } }));
    await assertProjectCheckScripts(cwd, [{ command: 'pnpm', args: ['run', 'build'] }]);
    await assert.rejects(assertProjectCheckScripts(cwd, [{ command: 'npm', args: ['run', 'typecheck'] }]), /отсутствуют.*typecheck/);
    await fs.writeFile(path.join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    assert.deepEqual(await readProjectPackageManager(cwd), { packageManager: 'pnpm', hasLockfile: true });

    const preparation = new WorktreePreparation(executor);
    await preparation.prepare(cwd, [], signal, () => {});
    await preparation.prepare(cwd, [], signal, () => {});
    assert.equal(calls.length, 1);
    await fs.writeFile(path.join(cwd, 'pnpm-workspace.yaml'), 'packages: []\n');
    await preparation.prepare(cwd, [], signal, () => {});
    assert.equal(calls.length, 2);
    await preparation.prepare(cwd, [{ command: 'npm', args: ['ci'] }], signal, () => {});
    await new PostOperationRunner(executor).run({ command: 'npm', args: ['run', 'build'] }, cwd, path.join(cwd, '.git'), signal);
    assert.deepEqual(calls, [
      { command: 'pnpm', args: ['install', '--frozen-lockfile', '--prod=false'] },
      { command: 'pnpm', args: ['install', '--frozen-lockfile', '--prod=false'] },
      { command: 'pnpm', args: ['install', '--frozen-lockfile', '--prod=false'] },
      { command: 'pnpm', args: ['run', 'build'] },
    ]);
    await fs.access(path.join(cwd, 'pnpm-lock.yaml'));
    await assert.rejects(fs.access(path.join(cwd, 'package-lock.json')), { code: 'ENOENT' });
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
