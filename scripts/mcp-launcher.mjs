import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
 */
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
