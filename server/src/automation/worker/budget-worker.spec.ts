import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, access, readFile } from 'node:fs/promises';
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
  for (const mode of ['tokens', 'time', 'terminal'] as const) {
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
          job.onUsage?.({ inputTokens: mode !== 'time' ? 100 : 1, cachedInputTokens: 0, outputTokens: 0,
            source: 'codex-json', reportedRequests: 1, missingRequests: 0 }, { terminal: mode === 'terminal' });
          if (mode === 'terminal') {
            assert.equal(job.signal.aborted, false);
            await writeFile(path.join(job.cwd, 'source.txt'), 'completed answer');
            return { text: JSON.stringify({ verdict: 'pass', summary: 'Completed before terminal usage', commitMessage: '[#SAT-1] - Сохранён ответ для проверки бюджета' }) };
          }
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
        if (mode === 'time' && (name.endsWith('claim') || name.endsWith('heartbeat')) && value) value.budgetElapsedMs = 20 * 60000 - 5000;
        return value as T;
      } }, 'budget-fixture', executor, new FixtureRunners());
      await worker.tick();
      const detail = app.automationService.detail(run.id);
      assert.equal(detail.run.status, 'failed'); assert.match(detail.run.summary, /budget exhausted/);
      assert.equal(calls, 1); assert.equal(detail.run.usageAttempts![0].usage!.inputTokens, mode !== 'time' ? 100 : 1);
      if (mode === 'terminal') {
        assert.equal(detail.run.usageAttempts![0].finished, true);
        const checkpoint = JSON.parse(await readFile(path.join(detail.run.checkout!.worktreePath, '.sat', 'stage-0-0.json'), 'utf8'));
        assert.equal(checkpoint.outcome.summary, 'Completed before terminal usage');
      }
      await access(path.join(detail.run.checkout!.worktreePath, 'source.txt'));
    } finally { app.close(); await rm(root, { recursive: true, force: true }); }
  }
});
