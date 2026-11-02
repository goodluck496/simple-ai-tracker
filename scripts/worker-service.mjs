import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');

function getHomeDir() {
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'SimpleAiTracker')
    : path.join(os.homedir(), '.cache', 'simple-ai-tracker');
}

function getHostsDir() {
  return path.join(getHomeDir(), 'hosts');
}

function getHostDir(workspace, mcpCommand, mcpArgs) {
  const key = createHash('sha256').update(JSON.stringify([workspace, mcpCommand, mcpArgs])).digest('hex');
  return path.join(getHostsDir(), key);
}

function isAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  if (!pid || !isAlive(pid)) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch {}
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

function findActiveHosts() {
  const hostsDir = getHostsDir();
  if (!fs.existsSync(hostsDir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(hostsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const hostDir = path.join(hostsDir, entry.name);
    const dbPath = path.join(hostDir, 'coordination.sqlite');
    const serviceMetaPath = path.join(hostDir, 'worker-service.json');
    let serviceMeta = null;
    if (fs.existsSync(serviceMetaPath)) {
      try {
        serviceMeta = JSON.parse(fs.readFileSync(serviceMetaPath, 'utf8'));
      } catch {}
    }
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath);
        const rows = db.prepare('SELECT * FROM owners WHERE key=?').all('host');
        db.close();
        for (const row of rows) {
          if (row.host === os.hostname() && isAlive(row.pid)) {
            const children = JSON.parse(row.children || '[]');
            results.push({
              key: entry.name,
              hostDir,
              dbPath,
              pid: row.pid,
              children,
              serviceMeta,
            });
          }
        }
      } catch {}
    } else if (serviceMeta && isAlive(serviceMeta.pid)) {
      results.push({
        key: entry.name,
        hostDir,
        dbPath,
        pid: serviceMeta.pid,
        children: [],
        serviceMeta,
      });
    }
  }
  return results;
}

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} ч. ${minutes} мин.`;
  if (minutes > 0) return `${minutes} мин. ${seconds} сек.`;
  return `${seconds} сек.`;
}

function parseCliArgs() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs.find(a => ['start', 'stop', 'restart', 'status', 'logs', 'service'].includes(a)) ?? 'status';
  const flags = rawArgs.filter(a => a !== command);

  const getArgValue = (name) => {
    const idx = flags.indexOf(name);
    return idx >= 0 && flags[idx + 1] ? flags[idx + 1] : undefined;
  };

  const workspace = getArgValue('--workspace') ?? process.env.SAT_WORKSPACE ?? 'default';
  const isDocker = flags.includes('--docker');
  const isLocal = !isDocker;
  const container = getArgValue('--container') ?? process.env.SAT_CONTAINER ?? 'simple-ai-tracker';
  const lines = parseInt(getArgValue('--lines') ?? '40', 10);
  const follow = flags.includes('-f') || flags.includes('--follow');
  const all = flags.includes('--all');
  const autoRestart = flags.includes('--auto-restart') || flags.includes('--restart');

  return {
    command: command === 'service' ? 'start' : command,
    workspace,
    isLocal,
    isDocker,
    container,
    lines,
    follow,
    all,
    autoRestart,
  };
}

async function buildServerIfNeeded() {
  const workerBundle = path.join(ROOT, 'dist', 'server', 'worker.mjs');
  return new Promise((resolve, reject) => {
    const build = spawn(process.execPath, ['scripts/build-server.mjs'], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    build.on('error', reject);
    build.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Сборка сервера завершилась с кодом ${code}`)));
  });
}

async function startService(opts) {
  const { workspace, isLocal, container } = opts;
  const isDocker = !isLocal;
  const mcpCommand = isDocker ? 'docker' : undefined;
  const mcpArgs = isDocker
    ? JSON.stringify(['exec', '-i', container, 'node', '/app/dist/server/mcp.mjs'])
    : undefined;

  const hostDir = getHostDir(workspace, mcpCommand, mcpArgs);
  fs.mkdirSync(hostDir, { recursive: true });

  // Проверяем, запущен ли уже воркер в этом окружении
  const dbPath = path.join(hostDir, 'coordination.sqlite');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath);
      const row = db.prepare('SELECT * FROM owners WHERE key=?').get('host');
      db.close();
      if (row && row.host === os.hostname() && isAlive(row.pid)) {
        if (opts.autoRestart) {
          console.log(`[simple-ai-tracker] Обнаружен работающий воркер (PID: ${row.pid}). Перезапуск со свежей сборкой...`);
          await stopService(opts);
          await delay(600);
        } else {
          console.log(`[simple-ai-tracker] Воркер уже запущен как служба (PID: ${row.pid}).`);
          console.log(`  Рабочая область: ${workspace}`);
          console.log(`  Лог-файл:        ${path.join(hostDir, 'worker-service.log')}`);
          console.log(`  Для остановки:   npm run worker:stop`);
          console.log(`  Для перезапуска: npm run worker:restart`);
          return;
        }
      }
    } catch {}
  }

  // Сборка сервера перед запуском
  await buildServerIfNeeded();

  const logFile = path.join(hostDir, 'worker-service.log');
  const logFd = fs.openSync(logFile, 'a');
  const banner = `\n=======================================================\n[simple-ai-tracker] Запуск службы воркера: ${new Date().toISOString()}\n=======================================================\n`;
  fs.writeSync(logFd, banner);

  const env = {
    ...process.env,
    SAT_WORKSPACE: workspace,
    ...(isDocker ? { SAT_MCP_COMMAND: mcpCommand, SAT_MCP_ARGS: mcpArgs } : {}),
  };

  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server', 'worker.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env,
  });

  const pid = child.pid;
  child.unref();
  fs.closeSync(logFd);

  const metaPath = path.join(hostDir, 'worker-service.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    pid,
    workspace,
    mode: isDocker ? 'docker' : 'local',
    container: isDocker ? container : undefined,
    logFile,
    startedAt: new Date().toISOString(),
  }, null, 2));

  // Ожидаем 800мс и проверяем, не упал ли процесс при старте
  await delay(800);
  if (!isAlive(pid)) {
    console.error(`[simple-ai-tracker] Ошибка при запуске службы воркера (процесс PID ${pid} завершился).`);
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      console.error('Последние записи в логе:');
      console.error(lines.slice(-15).join('\n'));
    }
    process.exitCode = 1;
    return;
  }

  console.log(`
=======================================================
 Simple AI Tracker — Служба воркера запущена в фоне
=======================================================
  Статус:           ● Активна (PID: ${pid})
  Режим:            ${isDocker ? `Docker (${container})` : 'Локальный'}
  Рабочая область:  ${workspace}
  Файл логов:       ${logFile}

  Команды управления:
    npm run worker:status   — проверить статус
    npm run worker:logs     — посмотреть логи
    npm run worker:stop     — остановить службу
    npm run worker:restart  — перезапустить службу
=======================================================
`);
}

async function stopService(opts) {
  const activeHosts = findActiveHosts();
  if (activeHosts.length === 0) {
    console.log('[simple-ai-tracker] Служба воркера не запущена.');
    return;
  }

  for (const host of activeHosts) {
    console.log(`[simple-ai-tracker] Остановка службы воркера (PID: ${host.pid})...`);
    
    // Мягкая остановка SIGTERM
    try {
      process.kill(host.pid, 'SIGTERM');
    } catch {}

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && isAlive(host.pid)) {
      await delay(150);
    }

    // Принудительное завершение, если не остановился
    if (isAlive(host.pid)) {
      killProcessTree(host.pid);
    }
    for (const childPid of host.children) {
      if (isAlive(childPid)) killProcessTree(childPid);
    }

    // Очистка coordination.sqlite
    if (fs.existsSync(host.dbPath)) {
      try {
        const db = new DatabaseSync(host.dbPath);
        db.prepare('DELETE FROM owners WHERE key=?').run('host');
        db.close();
      } catch {}
    }

    // Обновление метафайла
    const metaPath = path.join(host.hostDir, 'worker-service.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.stoppedAt = new Date().toISOString();
        meta.active = false;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch {}
    }

    console.log(`[simple-ai-tracker] ✓ Служба воркера (PID: ${host.pid}) успешно остановлена.`);
  }
}

async function statusService() {
  const activeHosts = findActiveHosts();
  if (activeHosts.length === 0) {
    console.log(`
=======================================================
 Simple AI Tracker — Статус службы воркера
=======================================================
  Статус: ○ Остановлена
  Для запуска выполните: npm run worker:service
=======================================================
`);
    return;
  }

  console.log(`
=======================================================
 Simple AI Tracker — Статус службы воркера
=======================================================`);
  for (const host of activeHosts) {
    const meta = host.serviceMeta;
    const uptimeStr = meta?.startedAt ? formatUptime(Date.now() - new Date(meta.startedAt).getTime()) : 'Неизвестно';
    console.log(`  Статус:           ● Активна`);
    console.log(`  PID:              ${host.pid}`);
    if (host.children.length > 0) {
      console.log(`  Дочерние процессы: ${host.children.join(', ')}`);
    }
    console.log(`  Рабочая область:  ${meta?.workspace ?? 'default'}`);
    console.log(`  Режим:            ${meta?.mode ?? 'auto'}`);
    console.log(`  Время работы:     ${uptimeStr}`);
    console.log(`  Лог-файл:         ${path.join(host.hostDir, 'worker-service.log')}`);
  }
  console.log(`
  Команды управления:
    npm run worker:logs     — посмотреть последние логи
    npm run worker:stop     — остановить службу
    npm run worker:restart  — перезапустить службу
=======================================================
`);
}

async function logsService(opts) {
  const activeHosts = findActiveHosts();
  let logFile = null;
  if (activeHosts.length > 0) {
    logFile = path.join(activeHosts[0].hostDir, 'worker-service.log');
  } else {
    // Ищем последний лог-файл в папке hosts
    const hostsDir = getHostsDir();
    if (fs.existsSync(hostsDir)) {
      for (const entry of fs.readdirSync(hostsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(hostsDir, entry.name, 'worker-service.log');
        if (fs.existsSync(candidate)) {
          logFile = candidate;
          break;
        }
      }
    }
  }

  if (!logFile || !fs.existsSync(logFile)) {
    console.log('[simple-ai-tracker] Лог-файл службы воркера пока не создан.');
    return;
  }

  console.log(`[simple-ai-tracker] Журнал работы воркера (${logFile}):\n`);
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.trimEnd().split('\n');
  const count = opts.lines || 40;
  console.log(lines.slice(-count).join('\n'));

  if (opts.follow) {
    console.log('\n[simple-ai-tracker] Отслеживание новых записей в логе (Ctrl+C для выхода)...');
    let currentSize = fs.statSync(logFile).size;
    while (true) {
      await delay(500);
      try {
        const newSize = fs.statSync(logFile).size;
        if (newSize > currentSize) {
          const stream = fs.createReadStream(logFile, { start: currentSize, end: newSize });
          stream.pipe(process.stdout);
          currentSize = newSize;
        }
      } catch {}
    }
  }
}

async function main() {
  const opts = parseCliArgs();
  switch (opts.command) {
    case 'start':
      await startService(opts);
      break;
    case 'stop':
      await stopService(opts);
      break;
    case 'restart':
      await stopService(opts);
      await delay(600);
      await startService(opts);
      break;
    case 'status':
      await statusService();
      break;
    case 'logs':
      await logsService(opts);
      break;
    default:
      console.log(`Использование:
  node scripts/worker-service.mjs start [--workspace default] [--local]
  node scripts/worker-service.mjs stop
  node scripts/worker-service.mjs restart
  node scripts/worker-service.mjs status
  node scripts/worker-service.mjs logs [--lines 50] [-f]
`);
  }
}

main().catch((err) => {
  console.error('[simple-ai-tracker] Ошибка службы воркера:', err.message);
  process.exitCode = 1;
});
