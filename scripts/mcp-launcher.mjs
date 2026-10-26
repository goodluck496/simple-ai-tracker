import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Точка входа MCP-сервера для проекта-потребителя.
 *
 * Зачем: MCP-клиент запускает `node scripts/mcp-launcher.mjs` без ручной сборки.
 * Если бандл `dist/server/mcp.mjs` отсутствует или старше исходников — он
 * собирается esbuild'ом, после чего загружается как обычный модуль.
 *
 * ВАЖНО: stdout принадлежит протоколу JSON-RPC, поэтому весь вывод сборки
 * перенаправляется в stderr.
 *
 * Docker-режим: если трекер запущен в контейнере (`docker compose up`), SQLite-база
 * лежит на bind-mount внутри контейнера, и второй (хостовый) процесс не может с ней
 * работать: Docker Desktop отдаёт каталог через virtiofs, блокировки SQLite не
 * пробрасываются, и запросы падают с `SQLITE_PROTOCOL: locking protocol`.
 * Поэтому при живом контейнере stdio MCP просто проксируется внутрь него:
 * `docker exec -i <container> node dist/server/mcp.mjs`. Тогда базу открывает
 * ровно один процесс — сервер трекера в контейнере.
 * Отключить проксирование: SAT_MCP_LOCAL=1. Другое имя контейнера: SAT_DOCKER_CONTAINER.
 */
const dockerContainer = process.env.SAT_DOCKER_CONTAINER ?? 'simple-ai-tracker';
const useLocal = process.env.SAT_MCP_LOCAL === '1';

const appRoot = path.resolve(import.meta.dirname, '..');
const entry = path.join(appRoot, 'dist', 'server', 'mcp.mjs');
const buildScript = path.join(appRoot, 'scripts', 'build-server.mjs');
const serverSources = path.join(appRoot, 'server', 'src');
const instructions = path.join(appRoot, 'AGENT_INSTRUCTIONS.md');

function logToStderr(message) {
  process.stderr.write(`[simple-ai-tracker] ${message}\n`);
}

function newestMtimeMs(directory) {
  let newest = 0;
  const walk = (current) => {
    for (const entryName of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entryName.name);
      if (entryName.isDirectory()) {
        walk(absolute);
        continue;
      }
      const stat = fs.statSync(absolute);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return newest;
}

function needsBuild() {
  if (!fs.existsSync(entry)) return true;
  const bundleMtime = fs.statSync(entry).mtimeMs;
  if (newestMtimeMs(serverSources) > bundleMtime) return true;
  if (fs.existsSync(instructions) && fs.statSync(instructions).mtimeMs > bundleMtime) return true;
  return false;
}

function build() {
  if (!fs.existsSync(buildScript)) {
    logToStderr(`Не найден сценарий сборки: ${buildScript}`);
    process.exit(1);
  }
  logToStderr('Сборка бандла сервера (первый запуск или исходники новее сборки)…');
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  // Любой вывод сборки — только в stderr, иначе ломается JSON-RPC в stdout.
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0 || !fs.existsSync(entry)) {
    logToStderr('Не удалось собрать сервер. Выполните вручную: npm install && npm run build:server');
    process.exit(1);
  }
  logToStderr('Сборка завершена.');
}

/** Контейнер трекера реально запущен? `docker inspect` отвечает быстро и не шумит в stdout. */
function dockerContainerRunning() {
  if (useLocal || !dockerContainer) return false;
  const probe = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', dockerContainer],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return probe.status === 0 && probe.stdout.trim() === 'true';
}

/** Прозрачный stdio-прокси в контейнер: JSON-RPC идёт через `docker exec -i`. */
function runInDocker(container) {
  logToStderr(`MCP-сервер запускается внутри контейнера ${container}`);
  const child = spawn('docker', ['exec', '-i', container, 'node', 'dist/server/mcp.mjs'],
    { stdio: 'inherit', windowsHide: true });
  const forward = signal => { try { child.kill(signal); } catch { /* процесс уже завершился */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('error', error => {
    logToStderr(`Не удалось запустить MCP внутри контейнера: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', code => process.exit(code ?? 1));
}

if (dockerContainerRunning()) {
  // Локальная сборка в docker-режиме не нужна: сервер уже собран в образе.
  runInDocker(dockerContainer);
} else {
  if (needsBuild()) build();
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    logToStderr(`Ошибка запуска MCP-сервера: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.message.includes('@modelcontextprotocol/sdk')) {
      logToStderr('Похоже, зависимости не установлены. Выполните: npm install --omit=dev');
    }
    process.exit(1);
  }
}
