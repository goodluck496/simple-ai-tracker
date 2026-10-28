import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionSupervisor } from './execution-supervisor.js';

test('supervisor owns one child, supports idempotent start/stop/restart and records crashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-supervisor-')); const entry = path.join(root, 'fixture.cjs'); const count = path.join(root, 'calls.txt');
  await fs.writeFile(entry, `require('node:fs').appendFileSync(${JSON.stringify(count)},'start\\n');process.send({type:'ready'});if(process.argv[2]==='crash')setTimeout(()=>process.exit(7),100);process.on('message',m=>{if(m.type==='stop'&&process.argv[2]!=='ignore')process.exit(0)});process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000);`);
  const tracked: boolean[] = [];
  const supervisor = new ExecutionSupervisor(entry, [], process.env, (_pid, active) => tracked.push(active), 5000);
  const crash = new ExecutionSupervisor(entry, ['crash'], process.env, undefined, 5000);
  const stubborn = new ExecutionSupervisor(entry, ['ignore'], process.env, undefined, 1000);
  try {
    const [first, duplicate] = await Promise.all([supervisor.start(), supervisor.start()]);
    assert.equal(first.state, 'running'); assert.equal(first.pid, duplicate.pid);
    assert.equal(await fs.readFile(count, 'utf8'), 'start\n');
    assert.equal((await supervisor.stop()).state, 'stopped'); assert.equal((await supervisor.stop()).state, 'stopped');
    assert.notEqual((await supervisor.start()).pid, first.pid);
    await supervisor.stop(); assert.deepEqual(tracked, [true, false, true, false]);
    await crash.start();
    for (let attempt = 0; attempt < 100 && crash.status().state !== 'stopped'; attempt++) await delay(20);
    assert.equal(crash.status().state, 'stopped'); assert.match(crash.status().error!, /7/);
    await supervisor.start(); await stubborn.start();
    assert.equal((await stubborn.stop()).state, 'stopped', 'A stuck child is terminated within the bound');
    assert.equal(supervisor.status().state, 'running', 'Stopping one executor cannot kill another');
  } finally { await supervisor.stop(); await crash.stop(); await stubborn.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
