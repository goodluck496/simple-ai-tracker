import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { bodyField, requireBodyField, sendJson } from '../router.js';

export function registerTagRoutes(router: Router, app: AppContainer): void {
  const { tagService } = app;

  router.get('/api/tags', ({ res }) => {
    sendJson(res, 200, { tags: tagService.list() });
  });

  router.post('/api/tags', ({ body, res }) => {
    const tag = tagService.add({
      name: requireBodyField<string>(body, 'name'),
      color: bodyField<string>(body, 'color'),
      description: bodyField<string>(body, 'description'),
    });
    sendJson(res, 201, { tag });
  });

  router.patch('/api/tags/:name', ({ params, body, res }) => {
    const existing = app.repos.tags.findByName(params.name);
    if (!existing) {
      sendJson(res, 404, { error: { code: 'TAG_NOT_FOUND', message: `Тег ${params.name} не найден.` } });
      return;
    }
    const updated = tagService.update(existing.id, {
      color: bodyField<string>(body, 'color'),
      description: bodyField<string>(body, 'description'),
    });
    sendJson(res, 200, { tag: updated });
  });

  router.delete('/api/tags/:name', ({ params, res }) => {
    const removed = tagService.remove(params.name);
    sendJson(res, removed ? 200 : 404, { success: removed, name: params.name });
  });
}
