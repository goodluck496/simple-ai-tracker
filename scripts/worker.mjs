import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

function getRegisteredWorkspaces() {
  const wsFile = path.join(root, 'data', 'workspaces.json');
  if (fs.existsSync(wsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
      if (Array.isArray(data.workspaces) && data.workspaces.length > 0) return data.workspaces;
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

// Если переданы команды управления службой (stop, status, logs, restart)
const serviceCommands = ['stop', 'restart', 'status', 'logs'];
const matchedCmd = args.find(a => serviceCommands.includes(a));
if (matchedCmd) {
  const serviceArgs = args.filter(a => !serviceCommands.includes(a));
  const service = spawn(process.execPath, ['scripts/worker-service.mjs', matchedCmd, ...serviceArgs], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  service.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  service.on('exit', (code) => { process.exitCode = code ?? 0; });
} else if (args.includes('--foreground') || args.includes('-f') || args.includes('--once')) {
  // Явный запуск в текущей консоли (интерактивный режим)
  const workspaceIndex = args.indexOf('--workspace');
  const specified = workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.env.SAT_WORKSPACE;
  const workspace = resolveWorkspace(specified) ?? 'default';
  if (!workspace || !/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(workspace)) throw new Error('Invalid workspace.');

  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, ['scripts/build-server.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
    build.on('error', reject); build.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`)));
  });

  process.stderr.write(`[simple-ai-tracker] Локальный воркер [${workspace}] запущен в интерактивном режиме (консоль).\n`);
  const isDocker = args.includes('--docker');
  const workerEnv = {
    ...process.env,
    SAT_WORKSPACE: workspace,
    ...(isDocker ? {
      SAT_MCP_COMMAND: 'docker',
      SAT_MCP_ARGS: JSON.stringify(['exec', '-i', '-e', `SAT_WORKSPACE=${workspace}`, process.env.SAT_CONTAINER ?? 'simple-ai-tracker', 'node', '/app/dist/server/mcp.mjs']),
    } : {}),
  };

  const worker = spawn(process.execPath, ['dist/server/worker.mjs', ...(args.includes('--once') ? ['--once'] : [])], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: workerEnv,
  });
  worker.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  worker.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  // По умолчанию: запуск как фоновой службы с авто-перезапуском при обновлении кода!
  const serviceArgs = args.filter(a => a !== 'start' && a !== '--service' && a !== '--daemon');
  const service = spawn(process.execPath, ['scripts/worker-service.mjs', 'start', '--auto-restart', ...serviceArgs], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  service.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  service.on('exit', (code) => { process.exitCode = code ?? 0; });
}
