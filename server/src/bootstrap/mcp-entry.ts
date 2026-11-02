import { createContainer } from './container.js';
import { TrackerMcpServer } from '../mcp/server.js';

/**
 * Точка входа MCP-сервера (stdio).
 * stdout принадлежит протоколу — все логи идут в stderr.
 */
const app = createContainer();

const server = new TrackerMcpServer(app);
await server.serve();

app.logger.info('MCP-сервер Simple AI Tracker запущен на stdio', { db: app.config.dbPath });

const shutdown = (signal: string): void => {
  app.logger.info('Завершение MCP-сервера', { signal });
  try {
    app.close();
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

process.stdin.on('close', () => shutdown('stdin_close'));
process.stdin.on('end', () => shutdown('stdin_end'));
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') shutdown('EPIPE');
});
