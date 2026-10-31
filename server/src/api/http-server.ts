import type { GoogleAuth } from './google-auth.js';
import http from 'node:http';
import type { AppContainer } from '../bootstrap/container.js';
import { Router, sendJson } from './router.js';
import { StaticFileServer } from './static-files.js';
import { registerTaskRoutes } from './routes/tasks.routes.js';
import { registerTagRoutes } from './routes/tags.routes.js';
import { registerSystemRoutes } from './routes/system.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerImageRoutes } from './routes/images.routes.js';
import { registerWorkspaceRoutes } from './routes/workspace.routes.js';
import { registerAutomationRoutes } from './routes/automation.routes.js';

export interface ApiServerOptions {
  readonly cors?: boolean;
  readonly auth?: GoogleAuth;
}

/**
 * HTTP-сервер: REST API карточек + раздача собранного веб-клиента.
 * API и UI живут на одном порту — трекер остаётся единым приложением.
 */
export function createApiServer(app: AppContainer, options: ApiServerOptions = {}): http.Server {
  const router = new Router();
  registerSystemRoutes(router, app);
  registerTaskRoutes(router, app);
  registerTagRoutes(router, app);
  registerAdminRoutes(router, app);
  registerImageRoutes(router, app);
  registerWorkspaceRoutes(router, app, app.workspaceManager);
  registerAutomationRoutes(router, app);

  const staticServer = new StaticFileServer(app.config.webDistDir);
  const cors = options.auth ? false : options.cors ?? true;

  const dispatch = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tracker-Workspace');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const workspace = url.pathname.startsWith('/api/workspaces') ? 'default'
        : req.headers['x-tracker-workspace'] ?? url.searchParams.get('workspace') ?? 'default';
      if (typeof workspace !== 'string') {
        sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'Invalid workspace header.' } });
        return;
      }
      try {
      void app.workspaceManager.within(workspace, () => router.handle(req, res)).then((handled) => {
        if (!handled) {
          sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Маршрут ${url.pathname} не найден.` } });
        }
      });
      } catch (error) {
        sendJson(res, 404, { error: { code: 'WORKSPACE_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      staticServer.serve(req, res, url.pathname, options.auth?.basePath);
      return;
    }

    sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} не поддерживается.` } });
  };
  return http.createServer((req, res) => {
    if (!options.auth) { dispatch(req, res); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    void options.auth.handle(req, res, url).then(handled => { if (!handled) dispatch(req, res); }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Request failed.' } });
      else res.end();
    });
  });
}
