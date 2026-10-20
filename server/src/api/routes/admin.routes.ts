import fs from 'node:fs';
import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { sendJson } from '../router.js';

/**
 * Админ-маршруты: бэкапы базы.
 * Доступ рассчитан на локальный запуск (трекер — личный инструмент).
 */
export function registerAdminRoutes(router: Router, app: AppContainer): void {
  const { backupService, config } = app;

  router.get('/api/admin/backups', ({ res }) => {
    const backups = backupService.list();
    sendJson(res, 200, {
      backups,
      directory: backupService.directory,
      keep: config.backupKeep,
      autoEnabled: config.backupEnabled,
      intervalHours: config.backupIntervalHours,
      maxPerDay: config.backupMaxPerDay,
    });
  });

  router.post('/api/admin/backup', ({ res }) => {
    const backup = backupService.create('manual');
    const removed = backupService.prune(config.backupKeep);
    sendJson(res, 201, { backup, removedByRotation: removed, keep: config.backupKeep });
  });

  router.delete('/api/admin/backups/:name', ({ params, res }) => {
    const removed = backupService.remove(params.name);
    sendJson(res, removed ? 200 : 404, { success: removed, name: params.name });
  });

  router.get('/api/admin/backups/:name/download', ({ params, res }) => {
    const record = backupService.require(params.name);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': record.size,
      'Content-Disposition': `attachment; filename="${record.name}"`,
    });
    fs.createReadStream(record.path).pipe(res);
  });
}
