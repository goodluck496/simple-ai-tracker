import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { PipelineWorker } from './pipeline-worker.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../../shared/automation/contracts.js';

test('worker runs isolated Git pipeline, executes real checks, fixes review findings and fast-forwards without marking done', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-pipeline-'));
  const repo = path.join(root, 'project with spaces');
  await mkdir(repo);
  const executor = new ProcessExecutor();
  const git = (args: string[]) => executor.run({ command: 'git', args, cwd: repo, signal: AbortSignal.timeout(30000) });
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['config', 'user.name', 'Tracker fixture']);
    await writeFile(path.join(repo, 'answer.txt'), '0', 'utf8');
    await git(['add', '.']); await git(['commit', '-m', 'initial fixture']);
    const bridge = path.join(root, 'fixture-agent.cjs');
    await writeFile(bridge, `const fs=require('node:fs'); const role=process.argv[2]; let verdict='pass'; let plan;
if(role==='analyst') plan='# Plan\\nUpdate answer and verify it.';
if(role==='developer') fs.writeFileSync('answer.txt',String(Number(fs.readFileSync('answer.txt','utf8'))+1));
if(role==='reviewer' && fs.readFileSync('answer.txt','utf8')!=='2') verdict='changes_requested';
process.stdout.write(JSON.stringify({verdict,summary:role+': '+verdict,plan}));`, 'utf8');
    const roles = ['analyst', 'developer', 'tester', 'reviewer'] as const;
    const settings: AutomationSettings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: repo, mergePolicy: 'local',
      connections: [{ id: 'fixture', label: 'Deterministic fixture', kind: 'native', supportsImages: false }],
      agents: roles.map((role) => ({ id: role, role, runner: 'custom', connectionId: 'fixture', model: 'fixture-only', instructions: '', command: process.execPath, args: [bridge, '{role}'] })),
      pipeline: [...roles], checks: [{ command: process.execPath, args: ['-e', "require('node:assert').ok(Number(require('node:fs').readFileSync('answer.txt','utf8'))>0)"] }] };
    app.automationService.configure(settings);
    const task = app.taskService.createTask({ title: 'Implement fixture answer' });
    const run = app.automationService.enqueue(task.id);
    const registry = new TrackerToolRegistry(app);
    const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await registry.call(name, args);
      const text = result.content.filter((item) => item.type === 'text').map((item) => item.type === 'text' ? item.text : '').join('');
      if (result.isError) throw new Error(text);
      return JSON.parse(text) as T;
    } }, 'fixture-worker', executor);
    assert.equal(await worker.tick(), true);
    const detail = app.automationService.detail(run.id);
    assert.equal(detail.run.status, 'merged', detail.run.summary);
    assert.equal(detail.run.revision, 1);
    assert.equal(detail.run.usageAttempts!.length, 7, 'Every role invocation, including revisions, retains its own token attempt');
    assert.ok(detail.run.usageAttempts!.every((attempt) => attempt.finished && !attempt.usage), 'Custom CLI output without usage remains unknown');
    assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
    assert.equal(await readFile(path.join(repo, 'answer.txt'), 'utf8'), '2');
    assert.equal((await git(['status', '--porcelain'])).trim(), '');
    assert.equal(await worker.tick(), false);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test('process executor terminates on cancellation and preserves Unicode argv', async () => {
  const executor = new ProcessExecutor();
  const value = 'Привет, мир & $()';
  const output = await executor.run({ command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', value], cwd: os.tmpdir(), signal: AbortSignal.timeout(5000) });
  assert.equal(output, value);
  await assert.rejects(executor.run({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: os.tmpdir(), signal: AbortSignal.timeout(100) }), /cancelled|timed out/);
});
