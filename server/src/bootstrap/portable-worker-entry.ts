import { stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkerApplication } from '../automation/worker/worker-application.js';
import { DEFAULT_TRACKER_CONTAINER } from '../../../shared/automation/launch-command.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('Tracker host worker: --workspace NAME --container NAME [--project ABSOLUTE_PATH] [--once]\nNeeds Node.js 22+, Docker CLI, Git and CodeGraph on the host. No tracker checkout or project npm install is needed.\n'); return;
  }
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index]; if (option === '--once') continue;
    if (!['--workspace', '--container', '--project'].includes(option) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Invalid worker argument: ${option}`);
    values.set(option, process.argv[++index]);
  }
  const workspace = values.get('--workspace') ?? 'default';
  const container = values.get('--container') ?? DEFAULT_TRACKER_CONTAINER;
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(workspace) || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(container)) throw new Error('Invalid workspace or container name.');
  const project = values.get('--project');
  if (project) {
    if (!path.isAbsolute(project) || !(await stat(project)).isDirectory()) throw new Error('Project must be an existing absolute folder on this computer.');
    process.chdir(project);
  }
  process.env.SAT_WORKSPACE = workspace;
  if (values.has('--container') || !process.env.SAT_MCP_COMMAND) {
    process.env.SAT_MCP_COMMAND = 'docker';
    process.env.SAT_MCP_ARGS = JSON.stringify(['exec', '-i', container, 'node', '/app/dist/server/mcp.mjs']);
  }
  await new WorkerApplication().run();
}
void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
