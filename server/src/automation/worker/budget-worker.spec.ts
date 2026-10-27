import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import { PipelineWorker } from './pipeline-worker.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

test('worker aborts on live usage or total active time, persists usage and preserves checkout', async () => {
  for (const mode of ['tokens', 'time'] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sat-budget-'));
    const repo = path.join(root, 'repo'); await mkdir(repo);
    const executor = new ProcessExecutor();
    const git = (args: string[]) => executor.run({ command: 'git', args, cwd: repo, signal: AbortSignal.timeout(30000) });
    const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
    let calls = 0;
    try {
      await git(['init', '-b', 'main']); await git(['config', 'user.email', 'fixture@example.invalid']);
      await git(['config', 'user.name', 'Fixture']); await writeFile(path.join(repo, 'source.txt'), 'fixture');
      await git(['add', '.']); await git(['commit', '-m', 'fixture']);
      app.automationService.configure({ ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: repo, baseBranch: 'main', maxInputTokens: 100,
        connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
        agents: (['developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'codex', connectionId: 'fixture', model: 'fixture', instructions: '' })),
        pipeline: ['developer', 'tester', 'reviewer'], checks: [{ command: process.execPath, args: ['--version'] }] });
      const task = app.taskService.createTask({ title: 'Budget fixture' });
      app.taskService.attachPlan({ id: task.id, planContent: '# Fixture', actor: 'agent' });
      const run = app.automationService.enqueue(task.id);
      const registry = new TrackerToolRegistry(app);
      class FixtureRunners extends AgentRunnerRegistry {
        public override get() { return { id: 'codex' as const, async run(job: AgentJob) {
          calls++;
          job.onUsage?.({ inputTokens: mode === 'tokens' ? 100 : 1, cachedInputTokens: 0, outputTokens: 0,
            source: 'codex-json', reportedRequests: 1, missingRequests: 0 });
          if (!job.signal.aborted) await new Promise<void>(resolve => job.signal.addEventListener('abort', () => resolve(), { once: true }));
          job.signal.throwIfAborted();
          return { text: '' };
        } }; }
      }
      const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
        const result = await registry.call(name, args);
        const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
        if (result.isError) throw new Error(text);
        const value = JSON.parse(text);
        if (mode === 'time' && name.endsWith('claim') && value) value.budgetElapsedMs = 20 * 60000 - 5000;
        return value as T;
      } }, 'budget-fixture', executor, new FixtureRunners());
      await worker.tick();
      const detail = app.automationService.detail(run.id);
      assert.equal(detail.run.status, 'failed'); assert.match(detail.run.summary, /budget exhausted/);
      assert.equal(calls, 1); assert.equal(detail.run.usageAttempts![0].usage!.inputTokens, mode === 'tokens' ? 100 : 1);
      await access(path.join(detail.run.checkout!.worktreePath, 'source.txt'));
    } finally { app.close(); await rm(root, { recursive: true, force: true }); }
  }
});
