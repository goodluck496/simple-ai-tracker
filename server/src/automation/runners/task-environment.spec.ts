import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import { TaskEnvironment } from './task-environment.js';
import { ProcessExecutor } from './process-executor.js';

test('task subprocess removes host tracker routing while retaining executable paths and provider credentials', async () => {
  const source: NodeJS.ProcessEnv = { ...process.env, SAT_WORKSPACE: 'host-private', SAT_DB_PATH: '/host/private.db',
    SAT_HOME: '/host', SAT_MCP_ARGS: 'host-transport', SAT_MCP_COMMAND: 'docker', SAT_CONTAINER: 'host',
    SAT_BACKUP_ENABLED: 'true', sat_workspace: 'case-insensitive-host', FIXTURE_PROVIDER_KEY: 'fixture-key' };
  const env = TaskEnvironment.create(source);
  assert.equal(source.SAT_WORKSPACE, 'host-private');
  assert.equal(env.PATH ?? env.Path, source.PATH ?? source.Path);
  assert.equal(env.FIXTURE_PROVIDER_KEY, 'fixture-key');
  const output = await new ProcessExecutor().run({ command: process.execPath, args: ['-e',
    'process.stdout.write(JSON.stringify({workspace:process.env.SAT_WORKSPACE,db:process.env.SAT_DB_PATH,key:process.env.FIXTURE_PROVIDER_KEY}))'],
    cwd: os.tmpdir(), env, signal: AbortSignal.timeout(5000) });
  assert.deepEqual(JSON.parse(output), { key: 'fixture-key' });
});
