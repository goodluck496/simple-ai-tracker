import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const workspaceIndex = args.indexOf('--workspace');
const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.env.SAT_WORKSPACE ?? 'default';
if (!workspace || !/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(workspace)) throw new Error('Invalid workspace.');
await new Promise((resolve, reject) => {
  const build = spawn(process.execPath, ['scripts/build-server.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
  build.on('error', reject); build.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`)));
});
const worker = spawn(process.execPath, ['dist/server/worker.mjs', ...(args.includes('--once') ? ['--once'] : [])], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, SAT_WORKSPACE: workspace, SAT_MCP_COMMAND: 'docker',
    SAT_MCP_ARGS: JSON.stringify(['exec', '-i', process.env.SAT_CONTAINER ?? 'simple-ai-tracker', 'node', '/app/dist/server/mcp.mjs']) },
});
worker.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
worker.on('exit', (code) => { process.exitCode = code ?? 1; });
