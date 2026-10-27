import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, access, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { SquashIntegration } from './squash-integration.js';
import { gitFixture } from './testing/git-fixture.js';

test('two competing source branches squash serially; source commits survive and publication replay is idempotent', async () => {
  const f = await gitFixture();
  try {
    const a = await f.branch('task1', 'a.txt', ['1\n', '2\n']); const b = await f.branch('task2', 'b.txt', ['1\n', '2\n']);
    let checks = 0; a.job.checks = b.job.checks = async () => { checks++; };
    const results = await Promise.all([new SquashIntegration().run(a.job), new SquashIntegration().run(b.job)]);
    assert.equal(checks, 2); assert.equal((await f.git(['rev-list', '--count', 'master'])).trim(), '3');
    assert.equal((await f.git(['rev-list', '--count', 'task1'])).trim(), '3');
    assert.equal((await f.git(['rev-list', '--count', 'task2'])).trim(), '3');
    assert.equal(await readFile(path.join(f.repository, 'a.txt'), 'utf8'), '2\n');
    assert.equal(await readFile(path.join(f.repository, 'b.txt'), 'utf8'), '2\n');
    await new SquashIntegration().run(a.job);
    assert.equal(checks, 2); assert.equal((await f.git(['rev-list', '--count', 'master'])).trim(), '3');
    assert.ok(results.every(result => result.candidateSha && result.state === 'publishing'));
  } finally { await f.dispose(); }
});

test('text conflict is resolved only in the integration checkout and the combined tree is checked', async () => {
  const f = await gitFixture();
  try {
    const a = await f.branch('task1', 'a.txt', ['2\n']); const b = await f.branch('task2', 'a.txt', ['3\n']);
    await new SquashIntegration().run(a.job);
    let resolved = 0;
    b.job.resolve = async (cwd, files) => { resolved++; assert.deepEqual(files, ['a.txt']); await writeFile(path.join(cwd, 'a.txt'), '5\n'); };
    b.job.checks = async cwd => { assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), '5\n'); };
    await new SquashIntegration().run(b.job);
    assert.equal(resolved, 1); assert.equal(await readFile(path.join(f.repository, 'a.txt'), 'utf8'), '5\n');
    assert.equal(await readFile(path.join(b.cwd, 'a.txt'), 'utf8'), '3\n');
  } finally { await f.dispose(); }
});

test('failed combined checks keep target unchanged; resume reuses candidate without invoking resolver', async () => {
  const f = await gitFixture();
  try {
    const a = await f.branch('task1', 'a.txt', ['1\n']); const b = await f.branch('task2', 'b.txt', ['1\n']);
    await new SquashIntegration().run(a.job); const target = (await f.git(['rev-parse', 'HEAD'])).trim();
    b.job.checks = async cwd => { assert.notEqual(await readFile(path.join(cwd, 'a.txt'), 'utf8'), '1\n', 'semantic conflict'); };
    await assert.rejects(new SquashIntegration().run(b.job), /semantic conflict/);
    assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), target);
    await access(`${b.cwd}-integration-1`);
    b.job.checks = async () => {};
    await new SquashIntegration().run(b.job);
    assert.equal((await f.git(['rev-list', '--count', 'HEAD'])).trim(), '3');
  } finally { await f.dispose(); }
});

test('target movement reruns integration checks and dirty user files are preserved', async () => {
  const f = await gitFixture();
  try {
    const a = await f.branch('task1', 'a.txt', ['1\n']); let checks = 0;
    a.job.checks = async () => {
      if (++checks === 1) { await writeFile(path.join(f.repository, 'external.txt'), 'external'); await f.git(['add', '.']); await f.git(['commit', '-m', 'external fixture change']); }
    };
    const result = await new SquashIntegration().run(a.job);
    assert.equal(result.attempt, 2); assert.equal(checks, 2);
    const b = await f.branch('task2', 'b.txt', ['1\n']);
    await writeFile(path.join(f.repository, 'user.txt'), 'do not remove');
    const target = (await f.git(['rev-parse', 'HEAD'])).trim();
    await assert.rejects(new SquashIntegration().run(b.job), /clean/);
    assert.equal(await readFile(path.join(f.repository, 'user.txt'), 'utf8'), 'do not remove');
    assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), target);
  } finally { await f.dispose(); }
});

test('ignored local files are not overwritten during squash publication', async () => {
  const f = await gitFixture();
  try {
    const source = await f.branch('task1', 'local.txt', ['task content']);
    await appendFile(path.join(f.common, 'info', 'exclude'), '\nlocal.txt\n');
    await writeFile(path.join(f.repository, 'local.txt'), 'user data');
    const before = (await f.git(['rev-parse', 'HEAD'])).trim();
    await assert.rejects(new SquashIntegration().run(source.job), /overwritten|untracked/i);
    assert.equal((await f.git(['rev-parse', 'HEAD'])).trim(), before);
    assert.equal(await readFile(path.join(f.repository, 'local.txt'), 'utf8'), 'user data');
  } finally { await f.dispose(); }
});
