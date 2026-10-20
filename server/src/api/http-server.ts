import http from 'node:http';
import type { AppContainer } from '../bootstrap/container.js';
import { Router, sendJson } from './router.js';
import { StaticFileServer } from './static-files.js';
import { registerTaskRoutes } from './routes/tasks.routes.js';
import { registerTagRoutes } from './routes/tags.routes.js';
import { registerSystemRoutes } from './routes/system.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerImageRoutes } from './routes/images.routes.js';

export interface ApiServerOptions {
  readonly cors?: boolean;
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

  const staticServer = new StaticFileServer(app.config.webDistDir);
  const cors = options.cors ?? true;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      void router.handle(req, res).then((handled) => {
        if (!handled) {
          sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Маршрут ${url.pathname} не найден.` } });
        }
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      staticServer.serve(req, res, url.pathname);
      return;
    }

    sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} не поддерживается.` } });
  });
}
