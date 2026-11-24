import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob, type AgentOutcome } from '../../../../shared/automation/contracts.js';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import { PipelineWorker } from './pipeline-worker.js';
import { gitFixture } from './testing/git-fixture.js';

test('plan review returns feedback to the analyst, waits for answers and publishes only the approved plan', async () => {
  const fixture = await gitFixture();
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const registry = new TrackerToolRegistry(app);
    const roles = ['analyst', 'plan-reviewer', 'developer'] as const;
    app.automationService.configure({
      ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: fixture.repository, baseBranch: 'master',
      connections: [{ id: 'native', label: 'Native', kind: 'native', supportsImages: false }],
      agents: roles.map(role => ({ id: role, role, runner: 'codex', model: 'fixture', connectionId: 'native', instructions: '' })),
      pipeline: [...roles], checks: [{ command: process.execPath, args: ['--version'] }],
    });
    const task = app.taskService.createTask({ title: 'Update the answer' });
    const run = app.automationService.enqueue(task.id);
    const calls: string[] = [];
    const approvedPlan = '1. Update a.txt to blue.\n2. Verify a.txt contains blue.';
    class Fixtures extends AgentRunnerRegistry {
      public override get() {
        return { id: 'codex' as const, async run(job: AgentJob) {
          const role = job.profile.role;
          const count = calls.filter(previous => previous === role).length + 1;
          calls.push(role);
          const order = JSON.parse(await readFile(path.join(job.cwd, '.sat/work-order.json'), 'utf8'));
          let outcome: AgentOutcome;
          if (role === 'analyst') {
            if (count === 2) assert.equal(order.planProposal.feedback, 'Specify the expected value.');
            if (count === 3) assert.match(JSON.stringify(order.task.questions), /Use blue/);
            outcome = { verdict: 'pass', summary: 'Proposed plan', plan: [
              '1. Update a.txt.', '1. Update a.txt using the expected color.', approvedPlan,
            ][count - 1] };
          } else if (role === 'plan-reviewer') {
            assert.equal(app.taskService.getTaskCard(task.id).plan, null, 'Draft is not attached before approval');
            assert.ok(order.planProposal.plan.startsWith('1. Update a.txt'));
            if (count === 1) outcome = { verdict: 'changes_requested', summary: 'Specify the expected value.' };
            else if (count === 2) outcome = { verdict: 'questions', summary: 'Need the desired color.', questions: ['Which color?'] };
            else {
              assert.equal(order.planProposal.plan, approvedPlan);
              outcome = { verdict: 'pass', summary: 'Verified the plan', plan: 'This must not replace the proposal.' };
            }
          } else {
            assert.equal(app.taskService.getTaskCard(task.id).plan?.content, approvedPlan);
            assert.equal(order.planProposal, undefined);
            await writeFile(path.join(job.cwd, 'a.txt'), 'blue\n');
            outcome = { verdict: 'pass', summary: 'Updated the answer', commitMessage: `[#${task.id}] - Обновлён ответ для проверки плана` };
          }
          return { text: JSON.stringify(outcome) };
        } };
      }
    }
    const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await registry.call(name, args);
      const response = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (result.isError) throw new Error(response);
      return JSON.parse(response) as T;
    } }, 'plan-review-fixture', fixture.executor, new Fixtures());

    await worker.tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'waiting');
    assert.deepEqual(calls, ['analyst', 'plan-reviewer', 'analyst', 'plan-reviewer']);
    const question = app.taskService.getTaskCard(task.id).unansweredQuestions[0];
    app.taskService.answerQuestions({ id: task.id, answers: [{ questionId: question.id, answer: 'Use blue' }], actor: 'user' });
    app.automationService.resume(run.id);
    await worker.tick();
    const result = app.automationService.detail(run.id).run;
    assert.equal(result.status, 'review', result.summary);
    assert.equal(result.revision, 0, 'Plan returns do not consume implementation revisions');
    assert.deepEqual(calls.slice(4), ['analyst', 'plan-reviewer', 'developer']);
    assert.equal(app.taskService.getTaskCard(task.id).planHistory.length, 1);
  } finally {
    app.close();
    await fixture.dispose();
  }
});
