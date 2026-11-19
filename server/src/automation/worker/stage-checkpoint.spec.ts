import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProcessExecutionError, ProcessExecutor, ProcessLaunchError } from '../runners/process-executor.js';
import { StageCheckpoint } from './stage-checkpoint.js';
import { CheckJournal } from './check-journal.js';
import { checkFingerprint } from '../check-evidence.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentRun } from '../../../../shared/automation/contracts.js';
import type { CheckExecution } from '../../../../shared/automation/improvement-metrics.js';

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

test('StageCheckpoint loads legacy checkpoints compatibly and requires matching SHA and check order', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-ckpt-checks-'));
  try {
    const executor = new ProcessExecutor();
    const signal = AbortSignal.timeout(30000);
    const git = (args: string[]) => executor.run({ command: 'git', args, cwd, signal });
    await git(['init', '-q']);
    await fs.writeFile(path.join(cwd, 'a.txt'), '1\n');
    await git(['add', 'a.txt']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'init']);
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    const checkpoint = new StageCheckpoint(cwd, 0, 0, git);
    const fp = await checkpoint.fingerprint();
    const checks = [{ command: 'npm', args: ['run', 'build'] }, { command: 'npm', args: ['run', 'typecheck'] }];
    const run = { id: 'run-1', revision: 0, settings: { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), checks } };

    // Legacy checkpoint without checkExecutions loads compatibly but invalidates checksComplete
    await checkpoint.save({
      key: 'k1', head, fingerprint: fp, priorHead: head, priorStatus: '',
      outcome: { verdict: 'pass', summary: 'ok' }, checksComplete: true,
    });
    const legacy = await checkpoint.load('k1', run);
    assert.ok(legacy);
    assert.equal(legacy.checksComplete, false);
    assert.equal(legacy.checkExecutions, undefined);

    // Matching SHA + check fingerprint preserves checksComplete
    const execs: CheckExecution[] = checks.map((c, position) => ({
      id: `00000000-0000-0000-0000-00000000000${position}`, runId: 'run-1', attempt: 1, stage: 0,
      phase: 'stage', revision: 0, sha: head, fingerprint: checkFingerprint(checks), position,
      command: c.command, args: c.args, outcome: { kind: 'exit', code: 0 }, at: new Date().toISOString(),
    }));
    await checkpoint.save({
      key: 'k1', head, fingerprint: fp, priorHead: head, priorStatus: '',
      outcome: { verdict: 'pass', summary: 'ok' }, checksComplete: true, checkExecutions: execs,
    });
    const matched = await checkpoint.load('k1', run);
    assert.equal(matched?.checksComplete, true);

    // Reordered checks invalidate checksComplete
    const reorderedRun = { ...run, settings: { ...run.settings, checks: [checks[1], checks[0]] } };
    const reordered = await checkpoint.load('k1', reorderedRun);
    assert.equal(reordered?.checksComplete, false);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('CheckJournal distinguishes exit code, launch error, cancellation and replays idempotently after crash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-journal-'));
  try {
    const checks = [{ command: 'npm', args: ['run', 'build'] }, { command: 'npm', args: ['run', 'typecheck'] }];
    const run = { id: 'run-j1', revision: 0, stage: 0, settings: { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), checks } } as unknown as AgentRun;
    const sha = 'a'.repeat(40);
    const delivered: CheckExecution[] = [];

    // 1. Non-zero exit on first command stops before second command
    let executed = 0;
    const j1 = new CheckJournal(path.join(root, 'c1'), async r => { delivered.push(r); });
    await assert.rejects(j1.run(run, 'stage', sha, 1, new AbortController().signal, async () => {
      executed++;
      throw new ProcessExecutionError('build failed', 2, '', '');
    }), /build failed/);
    assert.equal(executed, 1);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].outcome, { kind: 'exit', code: 2 });

    // 2. Launch error is distinguished from exit code
    const launchDelivered: CheckExecution[] = [];
    const j2 = new CheckJournal(path.join(root, 'c2'), async r => { launchDelivered.push(r); });
    await assert.rejects(j2.run(run, 'stage', sha, 1, new AbortController().signal, async () => {
      throw new ProcessLaunchError(new Error('spawn ENOENT'));
    }), /ENOENT/);
    assert.deepEqual(launchDelivered[0].outcome, { kind: 'launch_error' });

    // 3. Aborted signal records unknown outcome
    const abortDelivered: CheckExecution[] = [];
    const ac = new AbortController();
    const j3 = new CheckJournal(path.join(root, 'c3'), async r => { abortDelivered.push(r); });
    await assert.rejects(j3.run(run, 'stage', sha, 1, ac.signal, async () => {
      ac.abort();
      throw new Error('aborted');
    }), /aborted/);
    assert.deepEqual(abortDelivered[0].outcome, { kind: 'unknown' });

    // 4. Crash after 1st command passes: redelivery replays same ID without re-executing 1st command
    const dir4 = path.join(root, 'c4');
    const seenIds: string[] = [];
    let runsCount = 0;
    let failDeliverOnce = true;
    const j4First = new CheckJournal(dir4, async r => {
      seenIds.push(r.id);
      if (failDeliverOnce) { failDeliverOnce = false; throw new Error('network drop'); }
    });
    await assert.rejects(j4First.run(run, 'candidate', sha, 1, new AbortController().signal, async () => { runsCount++; }), /network drop/);
    assert.equal(runsCount, 1);
    const firstId = seenIds[0];

    const replayed: CheckExecution[] = [];
    const j4Retry = new CheckJournal(dir4, async r => { replayed.push(r); });
    const results = await j4Retry.run(run, 'candidate', sha, 1, new AbortController().signal, async () => { runsCount++; });
    assert.equal(runsCount, 2, 'First passing check must not re-execute');
    assert.equal(results[0].id, firstId, 'Replayed check keeps original ID');
    assert.equal(await j4Retry.verify(run, sha, 1, results.map(r => r.id)), true);
    assert.equal(await j4Retry.verify(run, 'b'.repeat(40), 1, results.map(r => r.id)), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
