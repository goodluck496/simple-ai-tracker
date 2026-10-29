import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitFixture } from './testing/git-fixture.js';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { PipelineWorker } from './pipeline-worker.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

test('planless developer saves its own plan, resumes same session and hands concise evidence to tester', async () => {
  const fixture = await gitFixture(), app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  const tools = new TrackerToolRegistry(app); let calls = 0; const roles: string[] = [];
  try {
    app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: fixture.repository, baseBranch: 'master',
      connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
      agents: (['developer', 'tester'] as const).map(role => ({ id: role, role, runner: 'antigravity', model: 'fixture', connectionId: 'n', instructions: '' })), pipeline: ['developer', 'tester'], checks: [{ command: process.execPath, args: ['--version'] }] });
    const task = app.taskService.createTask({ title: 'Fix the answer without a separate analyst', description: 'Update a.txt, preserve b.txt and verify the result.' });
    const run = app.automationService.enqueue(task.id);
    class Runners extends AgentRunnerRegistry {
      public override get() { return { id: 'antigravity' as const, async run(job: AgentJob) {
        calls++; roles.push(job.profile.role);
        if (calls === 1) {
          job.onSession?.('developer-session');
          await job.onCheckpoint!({ summary: 'Путь изменения найден', implementationPlan: ['Изменить a.txt и сохранить b.txt', 'Проверить значение a.txt'], nextStep: 'Изменить a.txt' });
          assert.ok(app.taskService.getTaskCard(task.id).plan, 'Plan is in the task before editing');
          throw new Error('Controlled infrastructure interruption after plan');
        }
        if (job.profile.role === 'developer') {
          assert.equal(job.sessionId, 'developer-session', 'Its own plan does not reset the conversation');
          await fs.writeFile(path.join(job.cwd, 'a.txt'), 'SOURCE_BODY_SHOULD_NOT_TRAVEL'.repeat(400));
        } else {
          assert.equal(job.sessionId, undefined);
          assert.doesNotMatch(job.prompt, /SOURCE_BODY_SHOULD_NOT_TRAVEL|diff --git/);
          assert.match(job.prompt, /Playwright/);
          const packet = JSON.parse(await fs.readFile(path.join(job.cwd, '.sat/work-order.json'), 'utf8'));
          assert.equal(packet.previousStage.current, true, 'Self-generated plan preserves current evidence');
          assert.ok(packet.changedFiles.includes('a.txt'));
          assert.ok(JSON.stringify(packet).length < 6000, 'No research transcript or source dump is transferred');
        }
        return { text: JSON.stringify({ verdict: 'pass', summary: 'Focused change and checks completed', commitMessage: `[#${task.id}] - Изменён ответ для проверки интегрированной разработки` }) };
      } }; }
    }
    const worker = () => new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await tools.call(name, args); const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } }, 'integrated-fixture', fixture.executor, new Runners());
    await worker().tick(); assert.equal(app.automationService.detail(run.id).run.status, 'failed');
    app.automationService.resume(run.id); await worker().tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'review');
    assert.deepEqual(roles, ['developer', 'developer', 'tester']);
  } finally { app.close(); await fixture.dispose(); }
});
