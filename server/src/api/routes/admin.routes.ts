import fs from 'node:fs';
import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { sendJson } from '../router.js';

/**
 * Админ-маршруты: бэкапы базы.
 * Доступ рассчитан на локальный запуск (трекер — личный инструмент).
 */
export function registerAdminRoutes(router: Router, app: AppContainer): void {

  router.get('/api/admin/backups', ({ res }) => {
    const backups = app.backupService.list();
    sendJson(res, 200, {
      backups,
      directory: app.backupService.directory,
      keep: app.config.backupKeep,
      autoEnabled: app.config.backupEnabled,
      intervalHours: app.config.backupIntervalHours,
      maxPerDay: app.config.backupMaxPerDay,
    });
  });

  router.post('/api/admin/backup', ({ res }) => {
    const backup = app.backupService.create('manual');
    const removed = app.backupService.prune(app.config.backupKeep);
    sendJson(res, 201, { backup, removedByRotation: removed, keep: app.config.backupKeep });
  });

  router.delete('/api/admin/backups/:name', ({ params, res }) => {
    const removed = app.backupService.remove(params.name);
    sendJson(res, removed ? 200 : 404, { success: removed, name: params.name });
  });

  router.get('/api/admin/backups/:name/download', ({ params, res }) => {
    const record = app.backupService.require(params.name);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': record.size,
      'Content-Disposition': `attachment; filename="${record.name}"`,
    });
    fs.createReadStream(record.path).pipe(res);
  });
}
