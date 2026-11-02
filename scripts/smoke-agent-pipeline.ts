import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../server/src/bootstrap/container.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { TrackerToolRegistry } from '../server/src/mcp/tools.js';
import { PipelineWorker } from '../server/src/automation/worker/pipeline-worker.js';
import { AgentRunnerRegistry } from '../server/src/automation/runners/registry.js';
import { ModelApiRunner } from '../server/src/automation/runners/model-api-runner.js';
import { ProjectEnvironment } from '../server/src/automation/runners/project-environment.js';
import { ProcessExecutor } from '../server/src/automation/runners/process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentRunner, type RunnerId } from '../shared/automation/contracts.js';

const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const baseUrl = option('--url'); const model = option('--model');
const timeoutMs = Number(option('--timeout-ms') ?? 180000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error('Invalid --timeout-ms.');
if (!!baseUrl !== !!model) throw new Error('Supply both --url and --model, or neither for deterministic controls only.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-pipeline-acceptance-'));
console.log(JSON.stringify({ artifacts: root }));

type Scenario = 'control' | 'dirty-main' | 'missing-purpose' | 'model';
async function scenario(kind: Scenario) {
  const directory = path.join(root, kind); const repository = path.join(directory, 'repo');
  await fs.mkdir(repository, { recursive: true });
  const executor = new ProcessExecutor(); const signal = AbortSignal.timeout(timeoutMs);
  const git = (args: string[], cwd = repository) => executor.run({ command: 'git', args, cwd, signal: AbortSignal.timeout(30000) });
  await git(['init', '-b', 'main']); await git(['config', 'user.name', 'Acceptance fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repository, 'answer.txt'), '0\n');
  await fs.writeFile(path.join(repository, 'keep.txt'), 'preserve\n');
  await git(['add', '.']); await git(['commit', '-m', 'fixture']);
  if (kind === 'dirty-main') await fs.writeFile(path.join(repository, 'keep.txt'), 'user change\n');
  const bridge = path.join(directory, 'agent.cjs');
  const subject = kind === 'missing-purpose' ? '[#SAT-1] - Изменён ответ по требованию задачи' : '[#SAT-1] - Изменён ответ, чтобы выполнить проверяемое требование';
  await fs.writeFile(bridge, `require('node:fs').writeFileSync('answer.txt','1\\n');console.log(JSON.stringify({verdict:'pass',summary:'Updated answer and preserved keep.txt',commitMessage:${JSON.stringify(subject)}}));`);
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  const progress: string[] = []; const requests: unknown[] = []; let calls = 0;
  const request: typeof fetch = async (url, input) => {
    const started = Date.now();
    const response = await fetch(url, { ...input, signal: AbortSignal.any([signal, ...(input?.signal ? [input.signal] : [])]) });
    const body = await response.clone().json() as { choices?: { finish_reason?: string; message?: Record<string, unknown> }[]; usage?: unknown };
    const message = body.choices?.[0]?.message;
    requests.push({ ms: Date.now() - started, status: response.status, finish: body.choices?.[0]?.finish_reason,
      contentChars: typeof message?.content === 'string' ? message.content.length : 0,
      reasoningChars: String(message?.reasoning ?? message?.reasoning_content ?? message?.thinking ?? '').length,
      tools: (message?.tool_calls as { function?: { name?: string } }[] | undefined)?.map(t => t.function?.name), usage: body.usage });
    await fs.writeFile(path.join(directory, 'requests.json'), JSON.stringify(requests, null, 2));
    return response;
  };
  class Runners extends AgentRunnerRegistry {
    public override get(id: RunnerId): AgentRunner {
      const original = super.get(id);
      return { id, run: async (job, report) => {
        calls++;
        if (kind !== 'model') return original.run(job, report);
        return new ModelApiRunner(executor, request).run(await new ProjectEnvironment().prepare(job, report), report);
      } };
    }
  }
  try {
    const checksMarker = path.join(directory, 'checks-passed.txt');
    app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: repository,
      baseBranch: 'main', maxRevisions: 0,
      connections: [{ id: 'fixture', label: 'Acceptance', kind: kind === 'model' ? 'openai-compatible' : 'native',
        ...(kind === 'model' ? { baseUrl, reasoningEffort: 'low' as const } : {}), supportsImages: false }],
      agents: [{ id: 'dev', role: 'developer', runner: kind === 'model' ? 'model-api' : 'custom', connectionId: 'fixture',
        model: model ?? 'fixture', instructions: 'Change only answer.txt from 0 to 1. Read the file, edit it, verify the result. Preserve keep.txt. Return pass only when the requested value is present. Exact commitMessage: [#SAT-1] - Изменён ответ, чтобы выполнить проверяемое требование',
        ...(kind === 'model' ? {} : { command: process.execPath, args: [bridge] }) }], pipeline: ['dev'],
      checks: [{ command: process.execPath, args: ['-e', `const fs=require('node:fs');require('node:assert').equal(fs.readFileSync('answer.txt','utf8').trim(),'1');require('node:assert').equal(fs.readFileSync('keep.txt','utf8'),'preserve\\n');fs.writeFileSync(${JSON.stringify(checksMarker)},'passed');`] }],
    });
    const task = app.taskService.createTask({ title: 'Set answer to one', description: 'Change answer.txt from 0 to 1. Preserve keep.txt. Validate with configured check.' });
    app.taskService.attachPlan({ id: task.id, planContent: '1. Read answer.txt and edit its value to 1.\n2. Run configured check 0 and return the required final JSON.', actor: 'agent' });
    const run = app.automationService.enqueue(task.id);
    const tools = new TrackerToolRegistry(app);
    const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await tools.call(name, args);
      if (name === 'tracker_automation_progress' && typeof (args as { text?: unknown }).text === 'string') progress.push((args as { text: string }).text);
      const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } }, 'acceptance-worker', executor, new Runners());
    await worker.tick();
    const detail = app.automationService.detail(run.id);
    let checksPassed = false; try { await fs.access(checksMarker); checksPassed = true; } catch { /* A failed stage retains its evidence. */ }
    const result = { kind, status: detail.run.status, summary: detail.run.summary, agentCalls: calls, requests: requests.length,
      checksPassed, sourceAnswer: await fs.readFile(path.join(repository, 'answer.txt'), 'utf8'),
      sourceKeep: await fs.readFile(path.join(repository, 'keep.txt'), 'utf8'), checkout: detail.run.checkout?.worktreePath,
      commit: detail.run.checkout ? (await git(['log', '-1', '--format=%s'], detail.run.checkout.worktreePath)).trim() : undefined,
      usage: detail.run.usageAttempts?.map(a => ({ input: a.usage?.inputTokens, output: a.usage?.outputTokens })) };
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    await fs.writeFile(path.join(directory, 'events.json'), JSON.stringify(detail.events, null, 2));
    await fs.writeFile(path.join(directory, 'progress.log'), progress.join(''));
    console.log(JSON.stringify(result)); return result;
  } finally { app.close(); }
}

const selected = option('--case');
if (selected && !['control', 'dirty-main', 'missing-purpose', 'model'].includes(selected)) throw new Error('Unknown --case.');
if (selected === 'model' && !baseUrl) throw new Error('Model scenario requires --url and --model.');
const cases: Scenario[] = selected ? [selected as Scenario] : ['control', 'dirty-main', 'missing-purpose', ...(baseUrl && model ? ['model' as const] : [])];
const results = [];
for (const kind of cases) results.push(await scenario(kind));
if (results.some(result => result.status !== 'review' || !result.checksPassed)) process.exitCode = 1;
