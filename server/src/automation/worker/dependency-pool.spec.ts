import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';
import { DependencyPool } from './dependency-pool.js';
import { RunPreparation } from './run-preparation.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../../shared/automation/contracts.js';

test('managed packages share one immutable install, mutable caches stay local and lock changes detach safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-dependencies-'));
  const common = path.join(root, 'common'); await fs.mkdir(common);
  let installs = 0;
  class Fixture extends ProcessExecutor {
    public override async run(request: ProcessRequest): Promise<string> {
      if (request.command === 'git') return request.args[0] === 'rev-parse' ? path.join(common, 'info', 'exclude') : '';
      if (request.command === 'npm' && request.args[0] === '--version') return '10.fixture';
      if (request.command === 'npm' && request.args[0] === 'config') return '{}';
      if (request.command === 'npm' && request.args[0] === 'ci') {
        installs++;
        const manifest = JSON.parse(await fs.readFile(path.join(request.cwd, 'package.json'), 'utf8'));
        const pkg = path.join(request.cwd, 'node_modules', 'fixture'); await fs.mkdir(pkg, { recursive: true });
        await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: manifest.dependencies.fixture, main: 'index.js' }));
        await fs.writeFile(path.join(pkg, 'index.js'), 'module.exports=1'); return 'installed';
      }
      return super.run(request);
    }
  }
  const executor = new Fixture();
  const pool = new DependencyPool(common, executor);
  const preparation = new RunPreparation(executor, common, { ...DEFAULT_AUTOMATION_SETTINGS, dependencyMode: 'linked' });
  const signal = AbortSignal.timeout(60000); const keys = new Set<string>();
  try {
    const a = path.join(root, 'a'); const b = path.join(root, 'b');
    for (const cwd of [a, b]) {
      await fs.mkdir(path.join(cwd, '.sat'), { recursive: true });
      await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
      await fs.writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    }
    const prepared = await Promise.all([preparation.prepare(a, signal, () => {}), preparation.prepare(b, signal, () => {})]);
    if (process.platform !== 'win32' && os.userInfo().uid === 0) {
      assert.ok(prepared.every(result => result.mode === 'isolated')); return;
    }
    assert.ok(prepared.every(result => result.mode === 'linked')); assert.equal(installs, 1);
    const key = prepared[0].key!; keys.add(key); assert.equal(prepared[1].key, key);
    const pa = path.join(a, 'node_modules', 'fixture'); const pb = path.join(b, 'node_modules', 'fixture');
    assert.equal((await fs.lstat(pa)).isSymbolicLink(), true);
    assert.equal(await fs.realpath(pa), await fs.realpath(pb));
    await assert.rejects(fs.writeFile(path.join(pa, 'index.js'), 'corrupt'), /EACCES|EPERM|EROFS/);
    for (const cwd of [a, b]) {
      await fs.mkdir(path.join(cwd, 'node_modules', '.cache'), { recursive: true });
      await fs.writeFile(path.join(cwd, 'node_modules', '.cache', 'result'), cwd);
    }
    assert.notEqual(await fs.readFile(path.join(a, 'node_modules', '.cache', 'result'), 'utf8'), await fs.readFile(path.join(b, 'node_modules', '.cache', 'result'), 'utf8'));
    await assert.rejects(pool.pruneUnused(key, signal), /still in use/);
    await fs.writeFile(path.join(a, 'package.json'), JSON.stringify({ dependencies: { fixture: '2.0.0' } }));
    await fs.writeFile(path.join(a, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {}, version: '2' }));
    assert.equal((await preparation.prepare(a, signal, () => {})).mode, 'isolated');
    assert.equal((await fs.lstat(path.join(a, 'node_modules', 'fixture'))).isSymbolicLink(), false);
    assert.equal(JSON.parse(await fs.readFile(path.join(pb, 'package.json'), 'utf8')).version, '1.0.0');
    assert.equal(installs, 2);
    await assert.rejects(pool.pruneUnused('../outside', signal), /Invalid managed cache key/);
  } finally {
    preparation.close();
    for (const key of keys) await pool.pruneUnused(key, AbortSignal.timeout(20000));
    pool.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
