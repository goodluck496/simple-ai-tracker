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

function isDockerContainerRunning(container = 'simple-ai-tracker') {
  try {
    const res = spawnSync('docker', ['ps', '-q', '-f', `name=^/${container}$`, '-f', `name=^${container}$`], { windowsHide: true, encoding: 'utf8' });
    return res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function getRegisteredWorkspaces() {
  const wsFile = path.join(ROOT, 'data', 'workspaces.json');
  if (fs.existsSync(wsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
      if (Array.isArray(data.workspaces) && data.workspaces.length > 0) {
        return data.workspaces;
      }
    } catch {}
  }
  return [{ name: 'default', label: 'default' }];
}

function resolveWorkspace(specified) {
  if (!specified) return undefined;
  const list = getRegisteredWorkspaces();
  const lower = specified.toLowerCase().trim();
  const match = list.find(w => w.name.toLowerCase() === lower || (w.label && w.label.toLowerCase() === lower));
  return match ? match.name : specified;
}

function parseCliArgs() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs.find(a => ['start', 'stop', 'restart', 'status', 'logs', 'service'].includes(a)) ?? 'status';
  const flags = rawArgs.filter(a => a !== command);

  const getArgValue = (name) => {
    const idx = flags.indexOf(name);
    return idx >= 0 && flags[idx + 1] ? flags[idx + 1] : undefined;
  };

  const container = getArgValue('--container') ?? process.env.SAT_CONTAINER ?? 'simple-ai-tracker';
  const rawWorkspace = getArgValue('--workspace') || process.env.SAT_WORKSPACE;
  const workspace = rawWorkspace ? resolveWorkspace(rawWorkspace) : undefined;
  const isDocker = flags.includes('--docker') ? true : flags.includes('--local') ? false : isDockerContainerRunning(container);
  const isLocal = !isDocker;
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

async function startOneService(workspace, opts) {
  const { isLocal, container } = opts;
  const isDocker = !isLocal;
  const mcpCommand = isDocker ? 'docker' : undefined;
  const mcpArgs = isDocker
    ? JSON.stringify(['exec', '-i', '-e', `SAT_WORKSPACE=${workspace}`, container, 'node', '/app/dist/server/mcp.mjs'])
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
          console.log(`[simple-ai-tracker] Перезапуск службы воркера для '${workspace}' (PID: ${row.pid})...`);
          await stopOneHost({ pid: row.pid, children: JSON.parse(row.children || '[]'), dbPath, hostDir });
          await delay(600);
        } else {
          console.log(`  ● ${workspace}: уже активна (PID: ${row.pid})`);
          return;
        }
      }
    } catch {}
  }

  const logFile = path.join(hostDir, 'worker-service.log');
  const logFd = fs.openSync(logFile, 'a');
  const banner = `\n=======================================================\n[simple-ai-tracker] Запуск службы воркера [${workspace}]: ${new Date().toISOString()}\n=======================================================\n`;
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
  try { fs.closeSync(logFd); } catch {}

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
    console.error(`  ✕ ${workspace}: ошибка запуска (процесс PID ${pid} завершился).`);
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      console.error('Последние записи в логе:');
      console.error(lines.slice(-15).join('\n'));
    }
    process.exitCode = 1;
    return;
  }

  const reg = getRegisteredWorkspaces().find(w => w.name === workspace);
  const label = reg?.label && reg.label !== workspace ? ` (${reg.label})` : '';
  console.log(`  ● ${workspace}${label}: служба активна (PID: ${pid})`);
}

async function startService(opts) {
  // Сборка сервера перед запуском всех служб
  await buildServerIfNeeded();

  const targetWorkspaces = opts.workspace
    ? [opts.workspace]
    : getRegisteredWorkspaces().map(w => w.name);

  console.log(`
=======================================================
 Simple AI Tracker — Запуск служб воркеров
=======================================================
  Режим:            ${opts.isDocker ? `Docker (${opts.container})` : 'Локальный'}
  Рабочие области:  ${targetWorkspaces.join(', ')}
=======================================================`);

  for (const ws of targetWorkspaces) {
    await startOneService(ws, opts);
  }

  console.log(`
  Службы запущены в фоне и ожидают команд.
  Управлять выполнением (Запустить/Остановить) можно из веб-интерфейса каждой доски.

  Команды управления:
    npm run worker:status   — проверить статус всех служб
    npm run worker:logs     — посмотреть логи
    npm run worker:stop     — остановить службы
    npm run worker:restart  — перезапустить службы
=======================================================
`);
}

async function stopOneHost(host) {
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
  for (const childPid of host.children || []) {
    if (isAlive(childPid)) killProcessTree(childPid);
  }

  // Очистка coordination.sqlite
  if (host.dbPath && fs.existsSync(host.dbPath)) {
    try {
      const db = new DatabaseSync(host.dbPath);
      db.prepare('DELETE FROM owners WHERE key=?').run('host');
      db.close();
    } catch {}
  }

  // Обновление метафайла
  if (host.hostDir) {
    const metaPath = path.join(host.hostDir, 'worker-service.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.stoppedAt = new Date().toISOString();
        meta.active = false;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch {}
    }
  }
}

async function stopService(opts) {
  const activeHosts = findActiveHosts();
  const hostsToStop = opts?.workspace
    ? activeHosts.filter(h => (h.serviceMeta?.workspace ?? 'default') === opts.workspace)
    : activeHosts;

  if (hostsToStop.length === 0) {
    console.log('[simple-ai-tracker] Службы воркеров не запущены.');
    return;
  }

  for (const host of hostsToStop) {
    const ws = host.serviceMeta?.workspace ?? 'default';
    console.log(`[simple-ai-tracker] Остановка службы воркера для '${ws}' (PID: ${host.pid})...`);
    await stopOneHost(host);
    console.log(`[simple-ai-tracker] ✓ Служба воркера для '${ws}' (PID: ${host.pid}) успешно остановлена.`);
  }
}

async function statusService(opts) {
  const activeHosts = findActiveHosts();
  const registered = getRegisteredWorkspaces();

  console.log(`
=======================================================
 Simple AI Tracker — Статус служб воркеров
=======================================================`);

  if (activeHosts.length === 0) {
    console.log(`  Статус: ○ Все службы остановлены`);
    console.log(`  Рабочие области: ${registered.map(w => w.name + (w.label && w.label !== w.name ? ` (${w.label})` : '')).join(', ')}`);
    console.log(`  Для запуска выполните: npm run worker:service`);
    console.log(`=======================================================\n`);
    return;
  }

  for (const ws of registered) {
    const host = activeHosts.find(h => (h.serviceMeta?.workspace ?? 'default') === ws.name);
    const label = ws.label && ws.label !== ws.name ? ` (${ws.label})` : '';
    if (host) {
      const meta = host.serviceMeta;
      const uptimeStr = meta?.startedAt ? formatUptime(Date.now() - new Date(meta.startedAt).getTime()) : 'Неизвестно';
      const childStr = host.children && host.children.length > 0 ? ` [дети: ${host.children.join(', ')}]` : '';
      console.log(`  ● ${ws.name}${label}:`);
      console.log(`      PID:          ${host.pid}${childStr}`);
      console.log(`      Режим:        ${meta?.mode ?? 'auto'}`);
      console.log(`      Время работы: ${uptimeStr}`);
      console.log(`      Лог:          ${path.join(host.hostDir, 'worker-service.log')}`);
    } else {
      console.log(`  ○ ${ws.name}${label}: не запущена`);
    }
  }

  // Также показываем любые активные хосты, не найденные в workspaces.json
  for (const host of activeHosts) {
    const wsName = host.serviceMeta?.workspace ?? 'default';
    if (!registered.some(w => w.name === wsName)) {
      console.log(`  ● ${wsName} (дополнительная): PID ${host.pid}`);
    }
  }

  console.log(`
  Команды управления:
    npm run worker:logs     — посмотреть последние логи
    npm run worker:stop     — остановить службы
    npm run worker:restart  — перезапустить службы
=======================================================
`);
}

async function logsService(opts) {
  const activeHosts = findActiveHosts();
  let host = null;
  if (opts.workspace) {
    host = activeHosts.find(h => (h.serviceMeta?.workspace ?? 'default') === opts.workspace);
  } else if (activeHosts.length > 0) {
    host = activeHosts[0];
  }

  let logFile = host ? path.join(host.hostDir, 'worker-service.log') : null;
  if (!logFile) {
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

  const wsName = host?.serviceMeta?.workspace ?? opts.workspace ?? 'default';
  console.log(`[simple-ai-tracker] Журнал работы воркера [${wsName}] (${logFile}):\n`);
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
      await statusService(opts);
      break;
    case 'logs':
      await logsService(opts);
      break;
    default:
      console.log(`Использование:
  node scripts/worker-service.mjs start [--workspace default] [--local]
  node scripts/worker-service.mjs stop [--workspace default]
  node scripts/worker-service.mjs restart [--workspace default]
  node scripts/worker-service.mjs status
  node scripts/worker-service.mjs logs [--workspace default] [--lines 50] [-f]
`);
  }
}

main().catch((err) => {
  console.error('[simple-ai-tracker] Ошибка службы воркера:', err.message);
  process.exitCode = 1;
});
