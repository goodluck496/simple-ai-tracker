import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { PipelineWorker } from './pipeline-worker.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../../shared/automation/contracts.js';

test('single developer invokes one fixture agent and runs mandatory checks before review; failure cannot pass', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-solo-')); const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  const executor = new ProcessExecutor(); const signal = AbortSignal.timeout(90000);
  const git = (args: string[]) => executor.run({ command: 'git', args, cwd: repository, signal });
  try {
    await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(path.join(repository, 'source.txt'), 'old'); await git(['add', '.']); await git(['commit', '-m', 'initial']);
    const bridge = path.join(root, 'fixture.cjs'); const calls = path.join(root, 'calls.txt'); const checks = path.join(root, 'checks.txt');
    await fs.writeFile(bridge, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'developer\\n');fs.writeFileSync('source.txt','implemented');console.log(JSON.stringify({verdict:'pass',summary:'implemented',commitMessage:'[#'+process.argv[2]+'] - Изменён исходник для проверки готового плана'}));`);
    app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: repository, baseBranch: 'main', executionMode: 'developer',
      connections: [{ id: 'n', label: 'Fixture', kind: 'native', supportsImages: false }], agents: [{ id: 'dev', role: 'developer', runner: 'custom', connectionId: 'n', model: 'fixture', command: process.execPath, args: [bridge, '{model}'], instructions: '' }], pipeline: ['dev'],
      checks: [{ command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(checks)},'checked\\n')`] }] });
    const registry = new TrackerToolRegistry(app);
    const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await registry.call(name, args); const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } }, 'fixture', executor);
    for (const success of [true, false]) {
      const task = app.taskService.createTask({ title: success ? 'Success' : 'Failed checks' });
      app.taskService.attachPlan({ id: task.id, planContent: '# Implement source', actor: 'agent' });
      const settings = app.automationService.settings(); settings.agents[0].model = task.id;
      if (!success) settings.checks = [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }];
      const run = app.automationService.enqueue(task.id, settings, false); await worker.tick();
      assert.equal(app.automationService.detail(run.id).run.status, success ? 'review' : 'failed');
      assert.notEqual(app.taskService.getTaskCard(task.id).status, 'done');
    }
    assert.equal((await fs.readFile(calls, 'utf8')).trim().split('\n').length, 2, 'Exactly one developer per run, no other roles');
    assert.equal((await fs.readFile(checks, 'utf8')).trim(), 'checked');
    assert.equal(await fs.readFile(path.join(repository, 'source.txt'), 'utf8'), 'old', 'Source repository stays isolated');
  } finally { app.close(); await fs.rm(root, { recursive: true, force: true }); }
});
