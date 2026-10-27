import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { RuntimeCoordinator } from './runtime-coordinator.js';

test('runtime coordination fences independent connections, respects the strictest active capacity and cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-coordinator-'));
  const a = new RuntimeCoordinator(path.join(root, 'runtime.sqlite')); const b = new RuntimeCoordinator(path.join(root, 'runtime.sqlite'));
  try {
    const first = a.tryAcquire('slot:one', 1)!;
    assert.equal(b.tryAcquire('slot:two', 8), undefined);
    assert.equal(b.tryAcquire('slot:one', 1), undefined);
    await assert.rejects(b.acquire('slot:two', AbortSignal.timeout(100), 8), /abort/i);
    first.release(); const next = b.tryAcquire('slot:one', 2)!; const extra = a.tryAcquire('slot:three', 2)!;
    assert.ok(next && extra); assert.equal(a.tryAcquire('slot:four', 2), undefined);
    first.release(); assert.equal(a.tryAcquire('slot:four', 2), undefined, 'stale release cannot delete a different owner');
    extra.release(); next.release();
  } finally { a.close(); b.close(); await rm(root, { recursive: true, force: true }); }
});

test('dead process locks recover atomically but surviving child processes retain ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-lock-crash-'));
  const file = path.join(root, 'runtime.sqlite'); const script = path.join(root, 'owner.ts');
  // Hosted by the test so Windows process-job teardown cannot reap it with the lock owner.
  const survivor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '' } });
  const module = path.resolve(import.meta.dirname, 'runtime-coordinator.ts').replace(/\\/g, '/');
  await writeFile(script, `import { spawn } from 'node:child_process';import { RuntimeCoordinator } from ${JSON.stringify(module)};
const store=new RuntimeCoordinator(${JSON.stringify(file)});const lease=store.tryAcquire('merge')!;
const child=Number(process.argv[2]);lease.child(child,true);
console.log(JSON.stringify({pid:process.pid,child}));setInterval(()=>{},1000);`, 'utf8');
  const worker = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), script, String(survivor.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let owner: { pid: number; child: number } | undefined;
  const store = new RuntimeCoordinator(file);
  try {
    owner = await new Promise<{ pid: number; child: number }>((resolve, reject) => {
      let data = ''; const timer = setTimeout(() => reject(new Error('Lock fixture timeout')), 10000);
      worker.stdout.setEncoding('utf8'); worker.stdout.on('data', chunk => { data += String(chunk); if (data.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(data.split('\n')[0])); } });
      worker.once('error', reject);
    });
    assert.equal(store.tryAcquire('merge'), undefined);
    process.kill(owner.pid, 'SIGKILL'); await new Promise(resolve => worker.once('close', resolve));
    assert.equal(store.tryAcquire('merge'), undefined, 'a live orphan still owns the worktree');
    const survivorClosed = new Promise(resolve => survivor.once('close', resolve)); process.kill(owner.child, 'SIGKILL'); await survivorClosed;
    const recovered = await store.acquire('merge', AbortSignal.timeout(10000)); recovered.release();
    assert.ok(store.tryAcquire('merge'));
  } finally {
    if (owner) for (const pid of [owner.pid, owner.child]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    worker.kill(); survivor.kill(); store.close(); await rm(root, { recursive: true, force: true });
  }
});
