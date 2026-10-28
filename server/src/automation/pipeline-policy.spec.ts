import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { AGENT_ROLES, DEFAULT_AUTOMATION_SETTINGS, type AgentRole } from '../../../shared/automation/contracts.js';
import { PipelinePolicy } from '../../../shared/automation/pipeline-policy.js';

test('custom pipelines run only selected roles; readonly results do not merge or fake implementation', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    const settings = service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', mergePolicy: 'local',
      connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: true }], agents: AGENT_ROLES.map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })),
      pipeline: ['developer'], checks: [{ command: 'npm', args: ['test'] }], artifactPaths: ['fixture.png'] });
    const cases: AgentRole[][] = [['analyst'], ['analyst', 'analyst'], ['reviewer'], ['tester', 'reviewer'], ['designer'], ['developer', 'reviewer'], ['tester', 'developer'], ['analyst', 'designer', 'reviewer']];
    for (const pipeline of cases) {
      const task = app.taskService.createTask({ title: pipeline.join(' → ') });
      if (!pipeline.includes('analyst')) app.taskService.attachPlan({ id: task.id, planContent: '# Approved fixture plan', actor: 'agent' });
      const run = service.enqueue(task.id, { ...settings, pipeline }, false); const owned = service.claim('fixture')!;
      assert.deepEqual(owned.settings.pipeline, pipeline);
      for (const role of pipeline) {
        service.beginStage(run.id, owned.leaseToken!);
        service.completeStage(run.id, owned.leaseToken!, { verdict: 'pass', summary: `${role} passed`, ...(role === 'analyst' ? { plan: '# Refined plan' } : {}) }, `sat/${run.id}`, 'a'.repeat(40));
      }
      const writes = PipelinePolicy.writes({ ...settings, pipeline });
      assert.equal(service.detail(run.id).run.status, writes ? 'integrating' : 'review');
      assert.equal(app.taskService.getTaskCard(task.id).status, writes ? 'review' : 'ready');
      if (writes) service.fail(run.id, owned.leaseToken!, 'End fixture integration');
    }
    const reviewTask = app.taskService.createTask({ title: 'Assessment without an implementation plan' });
    const review = service.enqueue(reviewTask.id, { ...settings, pipeline: ['reviewer'] }, false); const claimed = service.claim('fixture')!;
    service.beginStage(review.id, claimed.leaseToken!);
    service.completeStage(review.id, claimed.leaseToken!, { verdict: 'changes_requested', summary: 'Missing implementation found' }, `sat/${review.id}`, 'a'.repeat(40));
    assert.equal(service.detail(review.id).run.stage, 0); assert.equal(service.detail(review.id).run.status, 'review');
    assert.equal(app.taskService.getTaskCard(reviewTask.id).status, 'backlog');
    assert.equal(PipelinePolicy.checkAt({ ...settings, pipeline: ['developer', 'reviewer'] }, 0), true);
    assert.equal(PipelinePolicy.checkAt({ ...settings, pipeline: ['developer', 'tester', 'developer'] }, 2), true);
    assert.equal(PipelinePolicy.canDecompose({ ...settings, pipeline: ['analyst'] }), false);
  } finally { app.close(); }
});
