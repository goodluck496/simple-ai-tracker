import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProcessExecutor } from '../server/src/automation/runners/process-executor.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const appRoot = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(os.tmpdir(), 'sat-portable-'));
try {
  const worker = path.join(fixture, 'worker.cjs');
  await copyFile(path.join(appRoot, 'dist/server/worker-host.cjs'), worker);
  const executor = new ProcessExecutor();
  const progress: string[] = [];
  const run = (args: string[]) => executor.run({ command: process.execPath, args: [worker, ...args], cwd: fixture,
    env: { ...process.env, SAT_HOME: fixture, SAT_DB_PATH: path.join(fixture, 'data', 'tracker.db'), SAT_WORKSPACE: 'default',
      SAT_MCP_COMMAND: process.execPath, SAT_MCP_ARGS: JSON.stringify([path.join(appRoot, 'dist/server/mcp.mjs')]) },
    onProgress: (text) => progress.push(text), signal: AbortSignal.timeout(30000) });
  assert.ok((await run(['--help'])).includes('No tracker checkout'));
  await run(['--workspace', 'default', '--project', fixture, '--once']);
  assert.ok(progress.join('').includes(JSON.stringify(path.join(fixture, 'data', 'tracker.db'))), 'Copied worker must connect to the selected fixture store');
  const client = new Client({ name: 'portable-acceptance', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(appRoot, 'dist/server/mcp.mjs')],
    env: { SAT_HOME: fixture, SAT_DB_PATH: path.join(fixture, 'data', 'tracker.db') }, stderr: 'inherit' }));
  try {
    const response = await client.callTool({ name: 'tracker_automation_host_poll', arguments: { workspace: 'default', workerId: 'verify-configured-store' } });
    assert.equal(response.isError, undefined);
    const listed = await client.callTool({ name: 'tracker_list_workspaces', arguments: {} });
    const payload = JSON.parse((listed.content as { text: string }[])[0].text) as { workspaces: { dbPath: string }[] };
    assert.equal(payload.workspaces[0].dbPath, path.join(fixture, 'data', 'tracker.db'));
  } finally { await client.close(); }
  console.log('PASS: single copied worker file runs outside repository without node_modules, connects to fixture MCP and handles empty queue.');
} finally { await rm(fixture, { recursive: true, force: true }); }
