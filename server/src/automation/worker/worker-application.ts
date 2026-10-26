import { randomUUID } from 'node:crypto';
import { McpTrackerChannel } from './mcp-client.js';
import { PipelineWorker } from './pipeline-worker.js';
import { ProjectWorker } from './project-worker.js';
import { AUTOMATION_TIMING } from '../../../../shared/automation/contracts.js';
import { PROJECT_LIMITS } from '../../../../shared/automation/project.js';

export class WorkerApplication {
  public async run(): Promise<void> {
    const channel = new McpTrackerChannel(process.env.SAT_WORKSPACE ?? 'default');
    await channel.connect();
    const workerId = process.env.SAT_WORKER_ID ?? randomUUID();
    const worker = new PipelineWorker(channel, workerId);
    const projects = new ProjectWorker(channel, workerId);
    let projectTick: Promise<void> | undefined;
    const pollProjects = () => {
      if (!projectTick) projectTick = projects.tick().catch((error) => process.stderr.write(`Project worker: ${String(error)}\n`)).then(() => { projectTick = undefined; });
    };
    let stopping = false;
    const stop = () => { stopping = true; worker.stop(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      await projects.tick();
      const timer = setInterval(pollProjects, PROJECT_LIMITS.pollMs);
      try {
        process.stderr.write('Tracker worker connected. Waiting for explicitly queued runs.\n');
        do {
          const worked = await worker.tick();
          if (!worked && !stopping && !process.argv.includes('--once')) await new Promise((resolve) => setTimeout(resolve, AUTOMATION_TIMING.pollMs));
        } while (!stopping && !process.argv.includes('--once'));
      } finally { clearInterval(timer); await projectTick; }
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      await channel.close();
    }
  }
}
