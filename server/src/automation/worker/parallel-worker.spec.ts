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

test('parallel pipelines across workspaces isolate identical task IDs and squash both results into one repository', async () => {
  const f = await gitFixture(); const appRoot = path.join(f.root, 'tracker');
  const app = createContainer({ config: { appRoot, dbPath: path.join(appRoot, 'data', 'tracker.db') }, logger: new SilentLogger() });
  try {
    const settings = { ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: f.repository, baseBranch: 'master', mergePolicy: 'local' as const,
      connections: [{ id: 'fixture', label: 'Fixture', kind: 'native' as const, supportsImages: false }],
      agents: (['developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'custom' as const, connectionId: 'fixture', model: 'fixture',
        instructions: '', command: process.execPath, args: [] })), pipeline: ['developer', 'tester', 'reviewer'],
      checks: [{ command: process.execPath, args: ['-e', "require('node:assert').ok(Number(require('node:fs').readFileSync('a.txt','utf8'))>0)"] }] };
    app.workspaceManager.create('other', 'Other');
    const spaces = ['default', 'other'];
    const prepared = spaces.map((space, index) => app.workspaceManager.within(space, () => {
      app.automationService.configure(settings);
      const task = app.taskService.createTask({ title: index ? 'Second addition' : 'First addition' });
      app.taskService.attachPlan({ id: task.id, planContent: '# Fixture\nCombine changes without losing either task.', actor: 'agent' });
      return { task, run: app.automationService.enqueue(task.id) };
    }));
    assert.equal(prepared[0].task.id, prepared[1].task.id);
    let developers = 0; let resolvers = 0; let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    class Fixtures extends AgentRunnerRegistry {
      public override get() { return { id: 'custom' as const, async run(job: AgentJob) {
        const taskId = job.prompt.match(/"id":"(SAT-\d+)"/)![1];
        if (job.prompt.startsWith('Resolve only')) { resolvers++; await writeFile(path.join(job.cwd, 'a.txt'), '5\n'); }
        else if (job.profile.role === 'developer') {
          if (++developers === 2) release(); await both;
          await writeFile(path.join(job.cwd, 'a.txt'), job.prompt.includes('First addition') ? '2\n' : '3\n');
        }
        const usage = { inputTokens: 10, outputTokens: 1, source: 'codex-json' as const, reportedRequests: 1, missingRequests: 0 };
        job.onUsage?.(usage);
        return { usage, text: JSON.stringify({ verdict: 'pass', summary: 'Fixture checked',
          commitMessage: `[#${taskId}] - Изменено значение ответа, чтобы сохранить обе задачи` }) };
      } }; }
    }
    const registry = new TrackerToolRegistry(app);
    const channel = (workspace: string) => ({ workspace, async call<T>(name: string, args = {}): Promise<T> {
      const result = await registry.call(name, { ...args, workspace }); const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } });
    await Promise.all([new PipelineWorker(channel('default'), 'one', f.executor, new Fixtures()).tick(), new PipelineWorker(channel('other'), 'two', f.executor, new Fixtures()).tick()]);
    const final = prepared.map(({ run }, index) => app.workspaceManager.within(spaces[index], () => app.automationService.detail(run.id).run));
    assert.ok(final.every(run => run.status === 'merged'), JSON.stringify(final.map(run => ({ status: run.status, summary: run.summary }))));
    assert.equal(resolvers, 1); assert.equal(developers, 2);
    assert.notEqual(final[0].checkout!.worktreePath, final[1].checkout!.worktreePath);
    assert.equal(final.flatMap(run => run.usageAttempts ?? []).filter(a => a.kind === 'resolver').length, 1);
    assert.equal((await f.git(['rev-list', '--count', 'master'])).trim(), '3');
    assert.equal(await readFile(path.join(f.repository, 'a.txt'), 'utf8'), '5\n');
    assert.ok(prepared.every(({ task }, index) => app.workspaceManager.within(spaces[index], () => app.taskService.getTaskCard(task.id).status === 'review')));
  } finally { app.close(); await f.dispose(); }
});
