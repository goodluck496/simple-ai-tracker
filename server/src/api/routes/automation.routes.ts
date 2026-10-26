import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { bodyField, requireBodyField, sendJson } from '../router.js';
import { AGENT_ROLES, RUNNER_IDS } from '../../../../shared/automation/contracts.js';
import type { ProjectInput } from '../../../../shared/automation/project.js';
import { TASK_SELECTION_LIMIT } from '../../../../shared/automation/task-readiness.js';

export function registerAutomationRoutes(router: Router, app: AppContainer): void {
  router.get('/api/automation/host', ({ res }) => sendJson(res, 200, app.automationService.projects.status()));
  router.get('/api/automation/queue', ({ res }) => sendJson(res, 200, app.automationService.queue()));
  router.post('/api/automation/runs/:id/restart', ({ params, res }) => sendJson(res, 201, { run: app.automationService.restart(params.id) }));
  router.post('/api/automation/project-requests', ({ body, res }) => sendJson(res, 201, app.automationService.projects.enqueue(body as ProjectInput)));
  router.get('/api/automation/project-requests/:id', ({ params, res }) => sendJson(res, 200, app.automationService.projects.get(params.id)));
  router.get('/api/automation/catalog', ({ res }) => sendJson(res, 200, { roles: AGENT_ROLES, runners: RUNNER_IDS }));
  router.get('/api/automation/settings', ({ res }) => sendJson(res, 200, app.automationService.settings()));
  router.post('/api/automation/settings', ({ body, res }) => sendJson(res, 200, app.automationService.configure(body)));
  router.get('/api/automation/runs', ({ query, res }) => sendJson(res, 200, {
    runs: app.automationService.list(query.get('taskId') ?? undefined), activeTaskIds: app.automationService.activeTaskIds(),
    tasks: app.taskService.listTasks({ limit: TASK_SELECTION_LIMIT }).map(({ id, title, status, hasPlan, openQuestionsCount }) => ({ id, title, status, hasPlan, openQuestionsCount })),
  }));
  router.get('/api/automation/runs/:id', ({ params, res }) => sendJson(res, 200, app.automationService.detail(params.id)));
  router.post('/api/automation/runs', ({ body, res }) => sendJson(res, 201, { run: app.automationService.enqueue(requireBodyField<string>(body, 'taskId'), bodyField(body, 'settings')) }));
  router.post('/api/automation/runs/:id/cancel', ({ params, res }) => { app.automationService.cancel(params.id); sendJson(res, 200, { ok: true }); });
  router.post('/api/automation/runs/:id/resume', ({ params, res }) => sendJson(res, 200, { run: app.automationService.resume(params.id) }));
}
