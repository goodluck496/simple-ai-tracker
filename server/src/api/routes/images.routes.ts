import fs from 'node:fs';
import path from 'node:path';
import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { requireBodyField, sendJson } from '../router.js';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Скриншоты карточек: приём data-URL и раздача файлов. */
export function registerImageRoutes(router: Router, app: AppContainer): void {
  router.post('/api/images', ({ body, res }) => {
    const stored = app.imageService.storeDataUrl(requireBodyField<string>(body, 'dataUrl'));
    sendJson(res, 201, stored);
  });

  router.get('/api/images/:fileName', ({ params, res }) => {
    const filePath = app.imageService.resolveFile(params.fileName);
    if (!filePath) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Изображение ${params.fileName} не найдено.` } });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}
