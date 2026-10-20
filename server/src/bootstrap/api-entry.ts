import { createContainer } from './container.js';
import { createApiServer } from '../api/http-server.js';
import { BackupScheduler } from '../services/backup-scheduler.js';

/** Точка входа HTTP API + UI. */
const app = createContainer();
const server = createApiServer(app);

const scheduler = new BackupScheduler(
  app.backupService,
  {
    enabled: app.config.backupEnabled,
    intervalHours: app.config.backupIntervalHours,
    maxPerDay: app.config.backupMaxPerDay,
    keep: app.config.backupKeep,
  },
  app.logger,
);
scheduler.start();

server.listen(app.config.httpPort, app.config.httpHost, () => {
  app.logger.info('Simple AI Tracker запущен', {
    url: `http://${app.config.httpHost}:${app.config.httpPort}`,
    db: app.config.dbPath,
    tasks: app.taskService.getStats().total,
    webUi: app.config.webDistDir,
    backups: app.backupService.directory,
  });
});

const shutdown = (signal: string): void => {
  app.logger.info('Завершение работы', { signal });
  scheduler.stop();
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
