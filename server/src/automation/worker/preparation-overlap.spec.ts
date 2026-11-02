import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentRunner, type AgentJob, type RunnerId } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import { PipelineWorker } from './pipeline-worker.js';

for (const mode of ['success', 'failure', 'cancel'] as const) {
  test(`worker overlaps source analysis with setup and handles ${mode}`, { timeout: 30000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sat-worker-overlap-'));
    const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
    let release!: () => void; let started!: () => void;
    const setupStarted = new Promise<void>(resolve => { started = resolve; });
    const setupRelease = new Promise<void>(resolve => { release = resolve; });
    let setupDone = false; let calls = 0; let phaseWhileWaiting: string | undefined;
    class Executor extends ProcessExecutor {
      public override async run(request: ProcessRequest): Promise<string> {
        if (request.command !== 'fixture-setup') return super.run(request);
        started();
        await setupRelease;
        request.signal.throwIfAborted();
        if (mode === 'failure') throw new Error('fixture installation failed');
        setupDone = true; return '';
      }
    }
    const executor = new Executor();
    let worker: PipelineWorker;
    let runId: string;
    class Runners extends AgentRunnerRegistry {
      public override get(id: RunnerId): AgentRunner {
        return { id, run: async (job: AgentJob) => {
          calls++; await setupStarted;
          assert.equal(setupDone, false);
          assert.equal(await readFile(path.join(job.cwd, 'source.txt'), 'utf8'), 'source');
          assert.match(job.prompt, /prepared concurrently/);
          const waiting = job.waitForPreparation!();
          // Wait for setup phase to be persisted without timing-based sleeps.
          while (app.automationService.detail(runId).run.phase !== 'setup') await new Promise<void>(resolve => setImmediate(resolve));
          phaseWhileWaiting = app.automationService.detail(runId).run.phase;
          if (mode === 'cancel') worker.stop();
          release(); await waiting;
          assert.equal(setupDone, true);
          assert.equal(app.automationService.detail(runId).run.phase, 'agent');
          return { text: JSON.stringify({ verdict: 'pass', summary: 'read during setup', commitMessage: '[#SAT-1] - Проверено чтение, чтобы сократить ожидание' }) };
        } };
      }
    }
    try {
      const git = (args: string[]) => executor.run({ command: 'git', args, cwd: root, signal: AbortSignal.timeout(10000) });
      await git(['init', '-b', 'main']); await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Fixture']);
      await writeFile(path.join(root, 'source.txt'), 'source'); await git(['add', '.']); await git(['commit', '-m', 'fixture']);
      app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: root,
        connections: [{ id: 'api', label: 'Ollama', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: false }],
        agents: [{ id: 'dev', role: 'developer', runner: 'model-api', connectionId: 'api', model: 'fixture', instructions: '' }],
        pipeline: ['dev'], setup: [{ command: 'fixture-setup', args: [] }], checks: [{ command: process.execPath, args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('source.txt','utf8'),'source')"] }],
      });
      const task = app.taskService.createTask({ title: 'Overlap' });
      app.taskService.attachPlan({ id: task.id, planContent: '# Read source', actor: 'agent' });
      runId = app.automationService.enqueue(task.id).id;
      const registry = new TrackerToolRegistry(app);
      worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
        const result = await registry.call(name, args);
        const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
        if (result.isError) throw new Error(text);
        return JSON.parse(text) as T;
      } }, 'overlap-worker', executor, new Runners());
      await worker.tick();
      const result = app.automationService.detail(runId).run;
      assert.equal(calls, 1); assert.equal(phaseWhileWaiting, 'setup');
      assert.equal(result.status, mode === 'success' ? 'review' : 'failed', result.summary);
      if (mode === 'failure') assert.match(result.summary, /fixture installation failed/);
      if (mode !== 'success') assert.equal(setupDone, false);
    } finally { release(); app.close(); await rm(root, { recursive: true, force: true }); }
  });
}
