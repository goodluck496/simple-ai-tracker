import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { sendJson } from '../router.js';
import { STATUS_META, TASK_STATUSES } from '../../domain/task-status.js';
import { TASK_TYPE_META, TASK_TYPES } from '../../domain/task-type.js';
import {
  ATTACHMENT_KINDS,
  COMMENT_KINDS,
  LINK_RELATIONS,
  QUESTION_PHASES,
  SEARCH_SCOPES,
} from '../../domain/entities.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../../mcp/server.js';

export function registerSystemRoutes(router: Router, app: AppContainer): void {
  router.get('/api/health', ({ res }) => {
    sendJson(res, 200, {
      status: 'ok',
      app: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      db: app.config.dbPath,
      tasks: app.taskService.getStats().total,
    });
  });

  router.get('/api/meta', ({ res }) => {
    sendJson(res, 200, {
      app: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, idPrefix: app.config.idPrefix },
      statuses: TASK_STATUSES.map((status) => STATUS_META[status]),
      types: TASK_TYPES.map((type) => TASK_TYPE_META[type]),
      enums: {
        linkRelations: LINK_RELATIONS,
        questionPhases: QUESTION_PHASES,
        commentKinds: COMMENT_KINDS,
        attachmentKinds: ATTACHMENT_KINDS,
        searchScopes: SEARCH_SCOPES,
      },
    });
  });

  router.get('/api/stats', ({ res }) => {
    sendJson(res, 200, app.taskService.getStats());
  });

  router.post('/api/admin/reindex', ({ res }) => {
    const count = app.repos.search.rebuildAll();
    sendJson(res, 200, { success: true, indexed: count });
  });

  router.get('/api/instructions', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(app.instructionsService.get());
  });
}
