import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { sendJson, bodyField, requireBodyField } from '../router.js';
import { TrackerError } from '../../core/errors.js';
import type { WorkspaceManager } from '../../core/workspace-manager.js';

export function registerWorkspaceRoutes(router: Router, app: AppContainer, manager: WorkspaceManager): void {
  // GET /api/workspaces — список пространств
  router.get('/api/workspaces', ({ res }) => {
    sendJson(res, 200, {
      workspaces: manager.list(),
      current: manager.currentName,
    });
  });

  // GET /api/workspaces/:name — конкретное пространство
  router.get('/api/workspaces/:name', ({ params, res }) => {
    sendJson(res, 200, { workspace: manager.get(params.name), current: manager.currentName });
  });

  // POST /api/workspaces — создать
  router.post('/api/workspaces', ({ body, res }) => {
    const name = requireBodyField<string>(body, 'name');
    const label = bodyField<string>(body, 'label');
    const ws = manager.create(name, label);
    sendJson(res, 201, { workspace: ws });
  });

  // POST /api/workspaces/:name/activate — переключить
  router.post('/api/workspaces/:name/activate', ({ params, res }) => {
    const ws = manager.get(params.name);
    sendJson(res, 200, { workspace: ws, current: ws.name });
  });

  // DELETE /api/workspaces/:name — удалить
  router.delete('/api/workspaces/:name', ({ params, res }) => {
    manager.remove(params.name);
    sendJson(res, 200, { success: true, name: params.name });
  });
}
