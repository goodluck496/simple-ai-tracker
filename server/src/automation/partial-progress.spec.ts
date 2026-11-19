import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { AgentRole, AgentVerdict, DEFAULT_AUTOMATION_SETTINGS, RunStatus, type AutomationSettings } from '../../../shared/automation/contracts.js';

function fixture() {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  const pipeline = [AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer];
  const settings: AutomationSettings = {
    ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'native', label: 'Native', kind: 'native', supportsImages: false }],
    agents: pipeline.map(role => ({ id: role, role, runner: 'codex', connectionId: 'native', model: 'fixture', instructions: '' })),
    pipeline, checks: [{ command: 'node', args: ['--version'] }],
    pipelineRoutes: [{ from: 'tester', retry: { to: 'developer', limit: 0, exhausted: 'ask' } }],
  };
  const task = app.taskService.createTask({ title: 'Partial progress fixture' });
  const service = app.automationService;
  const run = service.enqueue(task.id, settings, false);
  const token = service.claim('fixture')!.leaseToken!;
  service.checkout(run.id, token, { repositoryRoot: '/fixture', worktreePath: '/fixture-worktree', baseSha: 'a'.repeat(40), dependencyMode: 'isolated' });
  const finish = (verdict: AgentVerdict) => {
    service.beginStage(run.id, token);
    return service.completeStage(run.id, token, { verdict, summary: 'Fixture evidence' }, `sat/${run.id}`, 'b'.repeat(40));
  };
  return { app, service, task, run, token, finish };
}

test('single check retry preserves the snapshot and stops on repeated rejection without routing to developer', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.resume(f.run.id, undefined, undefined, false, false, true), /resumed/);
    f.finish(AgentVerdict.Pass);
    const waiting = f.finish(AgentVerdict.ChangesRequested);
    assert.equal(waiting.status, RunStatus.Waiting);
    assert.throws(() => f.service.resume(f.run.id, undefined, undefined, false, false, true), /Answer task questions/);
    const question = f.app.taskService.getTaskCard(f.task.id).unansweredQuestions[0];
    f.app.taskService.answerQuestions({ id: f.task.id, answers: [{ questionId: question.id, answer: 'Repeat this check against the saved source.' }], actor: 'user' });
    const retried = f.service.resume(f.run.id, undefined, undefined, false, false, true);
    assert.equal(retried.stage, 1);
    assert.equal(retried.revision, waiting.revision + 1);
    assert.equal(retried.commitSha, waiting.commitSha);
    assert.deepEqual(retried.settings, waiting.settings);
    assert.deepEqual(retried.routeRetries, waiting.routeRetries);
    const token = f.service.claim('retry')!.leaseToken!;
    f.service.beginStage(f.run.id, token);
    const rejected = f.service.completeStage(f.run.id, token, { verdict: AgentVerdict.ChangesRequested, summary: 'Still failing' }, `sat/${f.run.id}`, 'b'.repeat(40));
    assert.equal(rejected.status, RunStatus.Failed);
    assert.equal(rejected.stage, 1);
    assert.equal(rejected.retryCurrentStage, undefined);
    assert.deepEqual(rejected.routeRetries, waiting.routeRetries);
  } finally { f.app.close(); }
});

test('successful single check retry follows the saved success route', () => {
  const f = fixture();
  try {
    f.finish(AgentVerdict.Pass);
    f.service.fail(f.run.id, f.token, 'Check interrupted');
    f.service.resume(f.run.id, undefined, undefined, false, false, true);
    const token = f.service.claim('retry')!.leaseToken!;
    f.service.beginStage(f.run.id, token);
    const result = f.service.completeStage(f.run.id, token, { verdict: AgentVerdict.Pass, summary: 'Verified' }, `sat/${f.run.id}`, 'b'.repeat(40));
    assert.equal(result.stage, 2);
    assert.equal(result.retryCurrentStage, undefined);
  } finally { f.app.close(); }
});

test('partial preview works while awaiting answers and fences continuation until rollback', () => {
  const f = fixture();
  try {
    assert.equal(f.service.detail(f.run.id).previewPatch.available, false);
    f.finish(AgentVerdict.Pass);
    f.finish(AgentVerdict.ChangesRequested);
    assert.equal(f.service.detail(f.run.id).previewPatch.available, true);
    const request = f.service.requestPreviewPatch(f.task.id, false, false, f.run.id);
    assert.equal(request.previewPatch?.head, 'b'.repeat(40));
    assert.equal(f.service.detail(f.run.id).run.status, RunStatus.Waiting);
    assert.throws(() => f.service.requestPreviewPatch(f.task.id, false, false, f.run.id), /уже выполняется/);
    const hostRequest = f.service.projects.poll('host')!;
    f.service.projects.complete(hostRequest.id, hostRequest.token!, { path: '/fixture' });
    assert.equal(f.service.detail(f.run.id).previewPatch.active, true);
    assert.throws(() => f.service.resume(f.run.id), /откатите/);
    const rollback = f.service.requestPreviewPatch(f.task.id, true, false, f.run.id);
    const hostRollback = f.service.projects.poll('host')!;
    assert.equal(hostRollback.id, rollback.id);
    f.service.projects.complete(hostRollback.id, hostRollback.token!, { path: '/fixture' });
    assert.equal(f.service.detail(f.run.id).previewPatch.active, false);
    assert.equal(f.app.taskService.getTaskCard(f.task.id).openQuestionsCount, 1);
    assert.equal(f.service.detail(f.run.id).run.stage, 1);
  } finally { f.app.close(); }
});

test('developer stages cannot use the check-only retry', () => {
  const f = fixture();
  try {
    f.service.fail(f.run.id, f.token, 'Writer interrupted');
    assert.throws(() => f.service.resume(f.run.id, undefined, undefined, false, false, true), /этапа проверки/);
  } finally { f.app.close(); }
});

test('manual acceptance finishes a stopped run without claiming the remaining checks passed', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.acceptManually(f.run.id), /остановленный/);
    f.finish(AgentVerdict.Pass);
    f.finish(AgentVerdict.ChangesRequested);
    assert.throws(() => f.service.acceptManually(f.run.id), /отвеченными вопросами/);
    const question = f.app.taskService.getTaskCard(f.task.id).unansweredQuestions[0];
    f.app.taskService.answerQuestions({ id: f.task.id, answers: [{ questionId: question.id, answer: 'Manually tested, works correctly.' }], actor: 'user' });
    const before = f.service.detail(f.run.id).run;
    const accepted = f.service.acceptManually(f.run.id);
    assert.equal(accepted.status, RunStatus.Review);
    assert.equal(accepted.stage, before.stage);
    assert.equal(accepted.commitSha, before.commitSha);
    assert.deepEqual(accepted.usageAttempts, before.usageAttempts);
    assert.equal(accepted.manualAcceptance?.sha, before.commitSha);
    assert.equal(f.app.taskService.getTaskCard(f.task.id).status, 'review');
    assert.ok(f.service.detail(f.run.id).events.some(event => event.kind === 'manual_acceptance'));
    assert.equal(f.service.queue(true, f.task.id).items[0].manualAcceptance?.sha, before.commitSha);
    f.service.acceptManually(f.run.id);
    assert.equal(f.service.detail(f.run.id).events.filter(event => event.kind === 'manual_acceptance').length, 1);
    const integration = f.service.reviewTask(f.task.id, 'accept');
    assert.equal(integration.stage, integration.settings.pipeline.length);
    assert.equal(integration.acceptedSha, before.commitSha);
  } finally { f.app.close(); }
});
