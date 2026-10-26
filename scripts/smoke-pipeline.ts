import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../server/src/bootstrap/container.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { TrackerToolRegistry } from '../server/src/mcp/tools.js';
import { PipelineWorker } from '../server/src/automation/worker/pipeline-worker.js';
import { ProcessExecutor } from '../server/src/automation/runners/process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, RunnerId, ProviderKind, RUNNER_IDS } from '../shared/automation/contracts.js';

const model = process.argv[2];
const runner = (process.argv[3] ?? RunnerId.ModelApi) as RunnerId;
if (!model || !RUNNER_IDS.includes(runner)) throw new Error('Usage: npx tsx scripts/smoke-pipeline.ts <model> [runner=model-api]');
const root = await mkdtemp(path.join(os.tmpdir(), 'sat-real-pipeline-'));
const repositoryPath = path.join(root, 'project'); await mkdir(repositoryPath);
const executor = new ProcessExecutor();
const signal = AbortSignal.timeout(600000);
const git = (args: string[]) => executor.run({ command: 'git', args, cwd: repositoryPath, signal });
const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
try {
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Tracker smoke']); await git(['config', 'user.email', 'smoke@example.invalid']);
  await writeFile(path.join(repositoryPath, 'answer.txt'), '0', 'utf8'); await git(['add', '.']); await git(['commit', '-m', 'initial']);
  const roles = ['analyst', 'developer', 'tester', 'reviewer'] as const;
  app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath, mergePolicy: 'local', timeoutMinutes: 10,
    connections: [{ id: 'local', label: 'Smoke connection', kind: runner === RunnerId.ModelApi ? ProviderKind.Ollama : ProviderKind.Native, baseUrl: process.env.SAT_OLLAMA_URL ?? 'http://localhost:11434', supportsImages: false, reasoningEffort: 'none' }],
    agents: roles.map((role) => ({ id: role, role, runner, connectionId: 'local', model,
      args: runner === RunnerId.Codex ? ['-c', 'model_reasoning_effort="low"'] : undefined,
      instructions: 'This is a clear, tiny acceptance fixture. Keep your answer concise. Developer must use write_file; analyst must return a markdown plan. Do not ask questions.' })),
    pipeline: [...roles], checks: [{ command: process.execPath, args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('answer.txt','utf8'),'1')"] }] });
  const task = app.taskService.createTask({ title: 'Set answer.txt to 1', description: 'Change only answer.txt so its complete UTF-8 content is exactly the single character 1, without a newline. Verify with the configured check.' });
  const queued = app.automationService.enqueue(task.id);
  const registry = new TrackerToolRegistry(app);
  const worker = new PipelineWorker({ async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (name === 'tracker_automation_begin_stage') process.stderr.write(`Starting stage ${app.automationService.detail(queued.id).run.stage + 1}\n`);
    const result = await registry.call(name, args);
    const text = result.content.filter((item) => item.type === 'text').map((item) => item.type === 'text' ? item.text : '').join('');
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  } }, 'real-model-smoke', executor);
  await worker.tick();
  const detail = app.automationService.detail(queued.id);
  assert.equal(detail.run.status, 'merged', JSON.stringify(detail));
  assert.equal(await readFile(path.join(repositoryPath, 'answer.txt'), 'utf8'), '1');
  assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
  console.log(`PASS: real ${runner}/${model} analysis/development/testing/review, configured check, isolated commits and local merge.`);
} finally { app.close(); await rm(root, { recursive: true, force: true }); }
