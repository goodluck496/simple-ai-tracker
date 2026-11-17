import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { AgentRole, AgentVerdict, DEFAULT_AUTOMATION_SETTINGS, RunStatus, type AutomationSettings } from '../../../shared/automation/contracts.js';

function settings(): AutomationSettings {
  const pipeline = [AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer];
  return { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', pipeline,
    connections: [{ id: 'native', label: 'Native', kind: 'native', supportsImages: false }],
    agents: pipeline.map(role => ({ id: role, role, runner: 'codex', connectionId: 'native', model: 'fixture', instructions: '' })),
    checks: [{ command: 'npm', args: ['test'] }],
  };
}

test('saved workflow retries a check, skips an optional review and finishes on its success route', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    const task = app.taskService.createTask({ title: 'Custom route fixture' });
    const draft = settings();
    service.configure(draft);
    draft.pipelineRoutes = [{ from: 'tester', passTo: null, retry: { to: 'developer', limit: 2, exhausted: 'stop' } }];
    const saved = service.taskTeam(task.id, draft).settings;
    assert.deepEqual(saved.pipelineRoutes, draft.pipelineRoutes);
    const run = service.enqueue(task.id, undefined, false);
    const token = service.claim('fixture')!.leaseToken!;
    const finish = (verdict: AgentVerdict, checkFailed = false) => {
      service.beginStage(run.id, token);
      return service.completeStage(run.id, token, { verdict, summary: 'fixture result' }, `sat/${run.id}`, 'a'.repeat(40), undefined, checkFailed);
    };
    assert.equal(finish(AgentVerdict.Pass).stage, 1);
    const returned = finish(AgentVerdict.ChangesRequested, true);
    assert.equal(returned.stage, 0);
    assert.equal(returned.routeRetries?.[1], 1);
    assert.deepEqual(returned.lastRoute, { from: 1, to: 0, kind: 'retry' });
    assert.equal(finish(AgentVerdict.Pass).stage, 1);
    const finished = finish(AgentVerdict.Pass);
    assert.equal(finished.stage, 3);
    assert.equal(finished.status, RunStatus.Review);
    assert.deepEqual(finished.usageAttempts?.map(attempt => attempt.role), ['developer', 'tester', 'developer', 'tester']);
    assert.match(service.detail(run.id).events.find(event => event.kind === 'route' && event.text.includes('Возврат'))!.text, /1\/2/);
  } finally { app.close(); }
});

test('exhausted checks ask for a decision and preserve counters on resume', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    const task = app.taskService.createTask({ title: 'Check escalation fixture' });
    const draft = settings();
    draft.pipelineRoutes = [{ from: 'reviewer', retry: { to: 'developer', limit: 1, exhausted: 'ask' } }];
    const run = service.enqueue(task.id, draft, false);
    const token = service.claim('fixture')!.leaseToken!;
    const finish = (verdict: AgentVerdict) => {
      service.beginStage(run.id, token);
      return service.completeStage(run.id, token, { verdict, summary: 'API behavior differs from the plan' }, `sat/${run.id}`, 'a'.repeat(40));
    };
    for (let round = 0; round < 2; round++) {
      finish(AgentVerdict.Pass);
      finish(AgentVerdict.Pass);
      const result = finish(AgentVerdict.ChangesRequested);
      assert.equal(result.routeRetries?.[2], 1);
      assert.equal(result.status, round ? RunStatus.Waiting : RunStatus.Running);
    }
    assert.equal(app.taskService.getTaskCard(task.id).openQuestionsCount, 1);
    assert.equal(service.detail(run.id).run.stage, 2);
    assert.throws(() => service.resume(run.id), /Answer task questions/);
    const question = app.taskService.getTaskCard(task.id).unansweredQuestions[0];
    app.taskService.answerQuestions({ id: task.id, answers: [{ questionId: question.id, answer: 'Update the sample response.' }], actor: 'user' });
    const resumed = service.resume(run.id);
    assert.equal(resumed.stage, 0);
    assert.equal(resumed.revision, 2);
    assert.equal(resumed.routeRetries?.[2], 1);
  } finally { app.close(); }
});

test('workflow validation protects required checks and rejects unreachable retry targets', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const draft = settings();
    const designer = { ...draft.agents[0], id: 'designer', role: AgentRole.Designer };
    draft.agents.push(designer);
    draft.pipeline.push(designer.id);
    draft.pipelineRoutes = [{ from: 'tester', passTo: null }];
    assert.throws(() => app.automationService.configure(draft), /обязательные команды/);
    draft.pipeline.pop();
    draft.pipelineRoutes = [
      { from: 'tester', passTo: null },
      { from: 'reviewer', retry: { to: 'developer', limit: 1, exhausted: 'stop' } },
    ];
    assert.throws(() => app.automationService.configure(draft), /повторится исходная проверка/);
  } finally { app.close(); }
});

test('visual validation can be queued without any configured images', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService;
    const draft = settings();
    const visual = { ...draft.agents[0], id: 'visual', role: AgentRole.VisualValidator };
    draft.agents.push(visual);
    draft.pipeline.splice(2, 0, visual.id);
    const task = app.taskService.createTask({ title: 'Visual validation fixture' });
    assert.equal(service.enqueue(task.id, draft, false).status, RunStatus.Queued);
    const visualTask = app.taskService.createTask({ title: 'Visual validation with image' });
    const queued = service.enqueue(visualTask.id, { ...draft, artifactPaths: ['screenshots/login.PNG'] }, false);
    assert.equal(queued.status, RunStatus.Queued);
  } finally { app.close(); }
});
