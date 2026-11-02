import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

// Если переданы команды службы (stop, start, status, logs, restart) или флаги службы
const serviceCommands = ['start', 'stop', 'restart', 'status', 'logs'];
const matchedCmd = args.find(a => serviceCommands.includes(a));
if (matchedCmd || args.includes('--service') || args.includes('--daemon')) {
  const action = matchedCmd ?? (args.includes('stop') ? 'stop' : 'start');
  const serviceArgs = args.filter(a => !serviceCommands.includes(a) && a !== '--service' && a !== '--daemon');
  const service = spawn(process.execPath, ['scripts/worker-service.mjs', action, ...serviceArgs], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  service.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  service.on('exit', (code) => { process.exitCode = code ?? 1; });
} else {
  const workspaceIndex = args.indexOf('--workspace');
  const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.env.SAT_WORKSPACE ?? 'default';
  if (!workspace || !/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(workspace)) throw new Error('Invalid workspace.');

  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, ['scripts/build-server.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
    build.on('error', reject); build.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`)));
  });

  process.stderr.write('[simple-ai-tracker] Локальный воркер запущен в терминале.\n');
  process.stderr.write('Подсказка: чтобы запустить как фоновую службу без привязки к терминалу: npm run worker:service (остановка: npm run worker:stop)\n');

  const isDocker = args.includes('--docker');
  const workerEnv = {
    ...process.env,
    SAT_WORKSPACE: workspace,
    ...(isDocker ? {
      SAT_MCP_COMMAND: 'docker',
      SAT_MCP_ARGS: JSON.stringify(['exec', '-i', process.env.SAT_CONTAINER ?? 'simple-ai-tracker', 'node', '/app/dist/server/mcp.mjs']),
    } : {}),
  };

  const worker = spawn(process.execPath, ['dist/server/worker.mjs', ...(args.includes('--once') ? ['--once'] : [])], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: workerEnv,
  });
  worker.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  worker.on('exit', (code) => { process.exitCode = code ?? 1; });
}
