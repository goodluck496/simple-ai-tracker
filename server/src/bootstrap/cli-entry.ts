import fs from 'node:fs';
import path from 'node:path';
import { createContainer } from './container.js';
import { MigrationRunner } from '../db/migration-runner.js';
import { ImportService } from '../services/import-service.js';
import { ExportService } from '../services/export-service.js';
import { StderrLogger } from '../core/logger.js';

/**
 * CLI Simple AI Tracker.
 *
 * Команды:
 *   doctor                           диагностика установки (пути, БД, MCP, UI, бэкапы)
 *   db:migrate                       применить миграции схемы
 *   db:stats                         статистика по базе
 *   db:backup [--export]             создать бэкап базы (+ JSON/markdown-снимок)
 *   db:backups                       список бэкапов
 *   db:restore --file <имя>          восстановить базу из бэкапа (сервер должен быть остановлен)
 *   import:json --source <dir> [--replace] [--manual-test]
 *   export:json [--out <dir>]
 *   reindex                          перестроить полнотекстовый индекс
 */
interface ParsedArgs {
  readonly command: string;
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

const HELP = `Simple AI Tracker CLI

  node dist/server/cli.mjs db:migrate
  node dist/server/cli.mjs db:stats
  node dist/server/cli.mjs db:backup [--export]
  node dist/server/cli.mjs db:backups
  node dist/server/cli.mjs db:restore --file <имя бэкапа>
  node dist/server/cli.mjs import:json --source <каталог legacy-проекта> [--replace] [--manual-test]
  node dist/server/cli.mjs export:json [--out <каталог>]
  node dist/server/cli.mjs reindex
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = new StderrLogger('cli', 'debug');
  const app = createContainer({ logger });

  try {
    switch (args.command) {
      case 'db:migrate': {
        const result = new MigrationRunner(app.db, logger).run();
        console.log(
          JSON.stringify({ schemaFrom: result.from, schemaTo: result.to, applied: result.applied, db: app.config.dbPath }, null, 2),
        );
        return;
      }
      case 'db:stats': {
        console.log(
          JSON.stringify(
            {
              db: app.config.dbPath,
              schemaVersion: app.db.getSchemaVersion(),
              stats: app.taskService.getStats(),
              meta: app.repos.meta.all(),
            },
            null,
            2,
          ),
        );
        return;
      }
      case 'doctor': {
        const dbExists = fs.existsSync(app.config.dbPath);
        const dbSize = dbExists ? fs.statSync(app.config.dbPath).size : 0;
        const webIndex = path.join(app.config.webDistDir, 'index.html');
        const mcpEntry = path.join(app.config.appRoot, 'dist', 'server', 'mcp.mjs');
        const backups = app.backupService.list();
        console.log(
          JSON.stringify(
            {
              node: process.version,
              appRoot: app.config.appRoot,
              database: {
                path: app.config.dbPath,
                created: dbExists,
                sizeBytes: dbSize,
                schemaVersion: app.db.getSchemaVersion(),
                tasks: app.taskService.getStats().total,
                tags: app.taskService.getStats().tags,
                note: dbExists ? undefined : 'база создаётся автоматически при первом запуске',
              },
              http: { host: app.config.httpHost, port: app.config.httpPort, idPrefix: app.config.idPrefix },
              webUi: { built: fs.existsSync(webIndex), path: app.config.webDistDir },
              mcp: { entry: mcpEntry, built: fs.existsSync(mcpEntry), launcher: 'scripts/mcp-launcher.mjs' },
              instructions: {
                file: app.instructionsService.path,
                exists: fs.existsSync(app.instructionsService.path),
                chars: app.instructionsService.get().length,
              },
              backups: {
                directory: app.backupService.directory,
                count: backups.length,
                autoEnabled: app.config.backupEnabled,
                intervalHours: app.config.backupIntervalHours,
                maxPerDay: app.config.backupMaxPerDay,
                keep: app.config.backupKeep,
                latest: backups[0]?.name ?? null,
              },
            },
            null,
            2,
          ),
        );
        return;
      }
      case 'db:backup': {
        const backup = app.backupService.create('cli');
        const removed = app.backupService.prune(app.config.backupKeep);
        let exportedFiles = 0;
        if (args.flags['export']) {
          const stamp = backup.name.replace(/\.db$/, '');
          const report = new ExportService(app).exportToJson(path.join(app.config.appRoot, 'export', stamp));
          exportedFiles = report.files.length;
        }
        console.log(
          JSON.stringify(
            { backup, removedByRotation: removed, keep: app.config.backupKeep, exportedFiles, db: app.config.dbPath },
            null,
            2,
          ),
        );
        return;
      }
      case 'db:backups': {
        console.log(
          JSON.stringify(
            {
              directory: app.backupService.directory,
              keep: app.config.backupKeep,
              autoEnabled: app.config.backupEnabled,
              intervalHours: app.config.backupIntervalHours,
              maxPerDay: app.config.backupMaxPerDay,
              backups: app.backupService.list(),
            },
            null,
            2,
          ),
        );
        return;
      }
      case 'db:restore': {
        const file = typeof args.flags['file'] === 'string' ? args.flags['file'] : undefined;
        if (!file) throw new Error('Укажи имя бэкапа: --file tracker-2026-10-19_15-04-12.db');
        const result = app.backupService.restore(file, { connection: app.db });
        console.log(
          JSON.stringify(
            {
              ...result,
              note: 'Соединение закрыто. Запусти сервер заново; при необходимости откатись на pre-restore бэкап.',
            },
            null,
            2,
          ),
        );
        return;
      }
      case 'import:json': {
        const source = typeof args.flags['source'] === 'string' ? args.flags['source'] : undefined;
        if (!source) throw new Error('Укажи каталог legacy-проекта: --source <dir>');
        const report = new ImportService(app.repos, undefined, logger).importFromJson({
          sourceDir: source,
          replace: Boolean(args.flags['replace']),
          requiresManualTest: Boolean(args.flags['manual-test']),
        });
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      case 'export:json': {
        const out = typeof args.flags['out'] === 'string' ? args.flags['out'] : 'export';
        const report = new ExportService(app).exportToJson(out);
        console.log(JSON.stringify({ outDir: report.outDir, tasks: report.tasks, tags: report.tags }, null, 2));
        return;
      }
      case 'reindex': {
        const indexed = app.repos.search.rebuildAll();
        console.log(JSON.stringify({ indexed }, null, 2));
        return;
      }
      default:
        console.log(HELP);
    }
  } finally {
    app.close();
  }
}

await main();
