import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerLaunchCommand } from '../../../../shared/automation/launch-command.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { WindowsFolderPicker } from './folder-picker.js';

test('launch command works without a project path and rejects invalid shell inputs', () => {
  const command = WorkerLaunchCommand.create('second-project');
  assert.ok(command.includes("'--workspace', 'second-project'"));
  assert.ok(command.includes('Start-Process')); assert.ok(command.includes('-WindowStyle Hidden'));
  assert.ok(command.includes('worker-host.cjs')); assert.ok(!command.includes('--project'));
  assert.ok(!command.includes('npm')); assert.ok(!command.includes('--prefix'));
  assert.throws(() => WorkerLaunchCommand.create('bad;name'));
  assert.throws(() => WorkerLaunchCommand.create('default', 'container; Write-Output bad'));
  assert.throws(() => WorkerLaunchCommand.create('default', 'container\ncommand'));
});

test('PowerShell command uses only workspace/container and runs Node from its independent helper folder', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-launch-'));
  try {
    const source = [
      '$satCalls = [System.Collections.Generic.List[object]]::new()',
      "function docker { $satCalls.Add(@{ name = 'docker'; argv = @($args) }); $global:LASTEXITCODE = 0 }",
      "function node { $satCalls.Add(@{ name = 'node'; argv = @($args); cwd = (Get-Location).Path }); $global:LASTEXITCODE = 0; if ($args[0] -eq '-p') { Write-Output 22 } }",
      "function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru) $satCalls.Add(@{name='host';argv=@($ArgumentList);cwd=$WorkingDirectory;hidden=$WindowStyle}); [pscustomobject]@{HasExited=$false} }",
      WorkerLaunchCommand.create('project-two', 'tracker-dev'),
      '[System.IO.File]::WriteAllText($env:SAT_CAPTURE, (ConvertTo-Json -InputObject @($satCalls.ToArray()) -Depth 5), [System.Text.UTF8Encoding]::new($false))',
    ].join('\n');
    const script = path.join(root, 'launch.ps1'); const capture = path.join(root, 'capture.json');
    await writeFile(script, '\uFEFF' + source, 'utf8');
    await new ProcessExecutor().run({ command: 'powershell.exe', args: ['-NoProfile', '-File', script], cwd: root,
      env: { ...process.env, LOCALAPPDATA: root, SAT_CAPTURE: capture }, signal: AbortSignal.timeout(15000) });
    const calls = JSON.parse(await readFile(capture, 'utf8')) as { name: string; argv: string[]; cwd?: string }[];
    assert.equal(calls[1].argv[1], 'tracker-dev:/app/dist/server/worker-host.cjs');
    assert.deepEqual(calls[2].argv.slice(1), ['--workspace', 'project-two', '--container', 'tracker-dev']);
    assert.equal(calls[2].cwd, path.join(root, 'SimpleAiTracker', 'workers'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows picker uses STA, environment data and UTF-8; cancellation and unsupported hosts are explicit', async () => {
  const initial = "E:\\проект\\O'Brien; $(anything)";
  const picker = new WindowsFolderPicker({ async run(request) {
    assert.equal(request.command, 'powershell.exe'); assert.ok(request.args.includes('-STA'));
    assert.equal(request.env?.SAT_PICKER_PATH, initial);
    assert.ok(!request.args.join(' ').includes(initial)); assert.ok(request.args.join(' ').includes('UTF8Encoding'));
    return 'E:\\выбранная папка';
  } }, 'win32');
  assert.equal(await picker.pick(initial), 'E:\\выбранная папка');
  assert.equal(await new WindowsFolderPicker({ async run() { return ''; } }, 'win32').pick(''), null);
  await assert.rejects(new WindowsFolderPicker({ async run() { throw new Error('must not execute'); } }, 'linux').pick(''), /Windows worker/);
});
