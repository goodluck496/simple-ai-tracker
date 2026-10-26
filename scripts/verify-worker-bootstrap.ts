import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessExecutor } from '../server/src/automation/runners/process-executor.js';
import { WorkerLaunchCommand } from '../shared/automation/launch-command.js';

if (process.platform !== 'win32') throw new Error('This acceptance scenario requires Windows PowerShell and Docker.');
const appRoot = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'sat-bootstrap-'));
const container = `sat-bootstrap-${randomUUID()}`;
const executor = new ProcessExecutor();
const docker = (args: string[]) => executor.run({ command: 'docker', args, cwd: root, signal: AbortSignal.timeout(30000) });
try {
  // No project mounts, no application server: MCP creates an empty disposable store.
  await docker(['create', '--name', container, '--entrypoint', 'sleep', 'simple-ai-tracker-simple-ai-tracker:latest', '300']);
  await docker(['cp', path.join(appRoot, 'dist/server/worker-host.cjs'), `${container}:/app/dist/server/worker-host.cjs`]);
  await docker(['start', container]);
  const localData = path.join(root, 'локальный helper'); const terminal = path.join(root, 'unrelated terminal folder');
  await mkdir(localData); await mkdir(terminal);
  const source = WorkerLaunchCommand.create('default', container).replace(/(& node \$satWorkerFile [^\n]+)/, '$1 --once');
  const file = path.join(root, 'launch.ps1'); await writeFile(file, '\uFEFF' + source, 'utf8');
  const progress: string[] = [];
  await executor.run({ command: 'powershell.exe', args: ['-NoProfile', '-File', file], cwd: terminal,
    env: { ...process.env, LOCALAPPDATA: localData, SAT_MCP_COMMAND: 'must-be-overridden', SAT_MCP_ARGS: '[]' },
    onProgress: (text) => progress.push(text), signal: AbortSignal.timeout(45000) });
  assert.ok(progress.join('').includes('Tracker worker connected.'), progress.join('').slice(-2000));
  console.log('PASS: generated PowerShell command performs real docker cp, launches Node from unrelated Unicode helper folder, overrides stale MCP env and connects to a disposable Docker MCP.');
} finally {
  await docker(['rm', '-f', '-v', container]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
