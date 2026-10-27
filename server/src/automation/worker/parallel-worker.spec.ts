import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import type { AgentJob } from '../../../../shared/automation/contracts.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../../shared/automation/contracts.js';
import { PipelineWorker } from './pipeline-worker.js';
import { gitFixture } from './testing/git-fixture.js';

test('parallel pipelines keep independent worktrees, meter one conflict resolver and squash both tasks into master', async () => {
  const f = await gitFixture(); const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    app.automationService.configure({ ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: f.repository, baseBranch: 'master', mergePolicy: 'local',
      connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
      agents: (['developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'custom', connectionId: 'fixture', model: 'fixture',
        instructions: '', command: process.execPath, args: [] })), pipeline: ['developer', 'tester', 'reviewer'],
      checks: [{ command: process.execPath, args: ['-e', "require('node:assert').ok(Number(require('node:fs').readFileSync('a.txt','utf8'))>0)"] }] });
    const tasks = [app.taskService.createTask({ title: 'First addition' }), app.taskService.createTask({ title: 'Second addition' })];
    const runs = tasks.map(task => {
      app.taskService.attachPlan({ id: task.id, planContent: '# Fixture\nCombine changes without losing either task.', actor: 'agent' });
      return app.automationService.enqueue(task.id);
    });
    let developers = 0; let resolvers = 0; let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    class Fixtures extends AgentRunnerRegistry {
      public override get() { return { id: 'custom' as const, async run(job: AgentJob) {
        const taskId = job.prompt.match(/"id":"(SAT-\d+)"/)![1];
        if (job.prompt.startsWith('Resolve only')) { resolvers++; await writeFile(path.join(job.cwd, 'a.txt'), '5\n'); }
        else if (job.profile.role === 'developer') {
          if (++developers === 2) release(); await both;
          await writeFile(path.join(job.cwd, 'a.txt'), taskId === tasks[0].id ? '2\n' : '3\n');
        }
        const usage = { inputTokens: 10, outputTokens: 1, source: 'codex-json' as const, reportedRequests: 1, missingRequests: 0 };
        job.onUsage?.(usage);
        return { usage, text: JSON.stringify({ verdict: 'pass', summary: 'Fixture checked',
          commitMessage: `[#${taskId}] - Изменено значение ответа, чтобы сохранить обе задачи` }) };
      } }; }
    }
    const registry = new TrackerToolRegistry(app);
    const channel = { async call<T>(name: string, args = {}): Promise<T> {
      const result = await registry.call(name, args); const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } };
    await Promise.all([new PipelineWorker(channel, 'one', f.executor, new Fixtures()).tick(), new PipelineWorker(channel, 'two', f.executor, new Fixtures()).tick()]);
    const final = runs.map(run => app.automationService.detail(run.id).run);
    assert.ok(final.every(run => run.status === 'merged'), JSON.stringify(final.map(run => ({ status: run.status, summary: run.summary }))));
    assert.equal(resolvers, 1); assert.equal(developers, 2);
    assert.notEqual(final[0].checkout!.worktreePath, final[1].checkout!.worktreePath);
    assert.equal(final.flatMap(run => run.usageAttempts ?? []).filter(a => a.kind === 'resolver').length, 1);
    assert.equal((await f.git(['rev-list', '--count', 'master'])).trim(), '3');
    assert.equal(await readFile(path.join(f.repository, 'a.txt'), 'utf8'), '5\n');
    assert.ok(tasks.every(task => app.taskService.getTaskCard(task.id).status === 'review'));
  } finally { app.close(); await f.dispose(); }
});
