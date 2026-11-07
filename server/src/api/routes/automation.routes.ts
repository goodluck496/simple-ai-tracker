import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { bodyField, requireBodyField, sendJson } from '../router.js';
import { AGENT_ROLES, RUNNER_IDS } from '../../../../shared/automation/contracts.js';
import type { ProjectInput } from '../../../../shared/automation/project.js';
import { TASK_SELECTION_LIMIT } from '../../../../shared/automation/task-readiness.js';
import { RunLogDownload } from '../../automation/run-log-download.js';

export function registerAutomationRoutes(router: Router, app: AppContainer): void {
  router.get('/api/automation/tasks/:id/preview-patch', ({ params, res }) =>
    sendJson(res, 200, { active: app.automationService.previewPatchActive(params.id), canResumeRework: app.automationService.canResumeRework(params.id) }));
  router.post('/api/automation/tasks/:id/preview-patch', ({ params, body, res }) =>
    sendJson(res, 201, app.automationService.requestPreviewPatch(params.id, bodyField(body, 'rollback') === true)));
  router.post('/api/automation/runs/:id/diff', ({ params, body, res }) =>
    sendJson(res, 201, app.automationService.requestDiff(params.id, bodyField(body, 'wholeRun') === true)));
  router.post('/api/automation/tasks/:id/review/accept', ({ params, res }) =>
    sendJson(res, 200, { run: app.automationService.reviewTask(params.id, 'accept') }));
  router.post('/api/automation/tasks/:id/review/rework', ({ params, body, res }) =>
    sendJson(res, 200, { run: app.automationService.reviewTask(params.id, 'rework', bodyField(body, 'feedback')) }));
  router.get('/api/automation/host', ({ res }) => sendJson(res, 200, app.automationService.projects.status()));
  router.get('/api/automation/queue', ({ res }) => sendJson(res, 200, app.automationService.queue(false)));
  router.get('/api/automation/history', ({ query, res }) => sendJson(res, 200, app.automationService.queue(true, query.get('taskId') ?? undefined)));
  router.post('/api/automation/runs/:id/cleanup', ({ params, body, res }) => sendJson(res, 202, app.automationService.cleanup(params.id, bodyField(body, 'discard') === true)));
  router.post('/api/automation/runs/:id/delete', ({ params, body, res }) => { app.automationService.deleteRun(params.id, bodyField(body, 'force') === true); sendJson(res, 200, { ok: true }); });
  router.get('/api/automation/runs/archive', ({ res }) => sendJson(res, 200, { runs: app.automationService.archive() }));
  router.post('/api/automation/runs/:id/hide', ({ params, res }) => { app.automationService.hide(params.id); sendJson(res, 200, { ok: true }); });
  router.post('/api/automation/runs/:id/restore', ({ params, res }) => { app.automationService.restore(params.id); sendJson(res, 200, { ok: true }); });
  router.post('/api/automation/runs/:id/restart', ({ params, res }) => sendJson(res, 201, { run: app.automationService.restart(params.id) }));
  router.post('/api/automation/project-requests', ({ body, res }) => sendJson(res, 201, app.automationService.projects.enqueue(body as ProjectInput)));
  router.get('/api/automation/project-requests/:id', ({ params, res }) => sendJson(res, 200, app.automationService.projects.get(params.id)));
  router.get('/api/automation/catalog', ({ res }) => sendJson(res, 200, { roles: AGENT_ROLES, runners: RUNNER_IDS }));
  router.get('/api/automation/settings', ({ res }) => sendJson(res, 200, app.automationService.settings()));
  router.get('/api/automation/tasks/:id/team', ({ params, res }) => sendJson(res, 200, app.automationService.taskTeam(params.id)));
  router.post('/api/automation/tasks/:id/team', ({ params, body, res }) => sendJson(res, 200, app.automationService.taskTeam(params.id, body)));
  router.post('/api/automation/tasks/:id/team/reset', ({ params, res }) => sendJson(res, 200, app.automationService.taskTeam(params.id, null)));
  router.post('/api/automation/settings', ({ body, res }) => sendJson(res, 200, app.automationService.configure(body)));
  router.get('/api/automation/runs', ({ query, res }) => sendJson(res, 200, {
    runs: app.automationService.list(query.get('taskId') ?? undefined), activeTaskIds: app.automationService.activeTaskIds(),
    tasks: app.taskService.listTasks({ limit: TASK_SELECTION_LIMIT }).map(({ id, title, status, hasPlan, openQuestionsCount, trustedExecution }) => ({ id, title, status, hasPlan, openQuestionsCount, trustedExecution: trustedExecution === true })),
  }));
  router.get('/api/automation/runs/:id', ({ params, res }) => sendJson(res, 200, app.automationService.detail(params.id)));
  router.get('/api/automation/runs/:id/log', ({ params, res }) => new RunLogDownload(app.automationService).send(params.id, res));
  router.post('/api/automation/runs', ({ body, res }) => sendJson(res, 201, { run: app.automationService.enqueue(requireBodyField<string>(body, 'taskId'), bodyField(body, 'settings'), false) }));
  router.post('/api/automation/batch', ({ body, res }) => sendJson(res, 201, { runs: app.automationService.enqueueBatch(bodyField(body, 'taskIds'), bodyField(body, 'settings'), bodyField(body, 'requestId')) }));
  router.post('/api/automation/runs/:id/cancel', ({ params, res }) => { app.automationService.cancel(params.id); sendJson(res, 200, { ok: true }); });
  router.post('/api/automation/runs/:id/budget', ({ params, body, res }) => sendJson(res, 200, { run: app.automationService.extendBudget(params.id, body) }));
  router.post('/api/automation/runs/:id/dequeue', ({ params, res }) => { app.automationService.dequeue(params.id); sendJson(res, 200, { ok: true }); });
  router.post('/api/automation/runs/:id/resume', ({ params, body, res }) => sendJson(res, 200, { run: app.automationService.resume(params.id, bodyField(body, 'replacementProfileId'), bodyField(body, 'replacementModel')) }));
  router.post('/api/automation/runs/:id/fix/diagnose', async ({ params, res }) => sendJson(res, 200, { fix: await app.automationService.diagnoseFix(params.id) }));
  router.post('/api/automation/runs/:id/fix/apply', async ({ params, res }) => sendJson(res, 200, { run: await app.automationService.applyFix(params.id) }));
  router.post('/api/automation/runs/:id/fix/discard', async ({ params, res }) => sendJson(res, 200, { run: await app.automationService.discardFix(params.id) }));
}
