import { randomUUID } from 'node:crypto';
import { McpTrackerChannel } from './mcp-client.js';
import { PipelineWorker } from './pipeline-worker.js';
import { ProjectWorker } from './project-worker.js';
import { AUTOMATION_TIMING } from '../../../../shared/automation/contracts.js';
import { PROJECT_LIMITS } from '../../../../shared/automation/project.js';
import { AutomationTool } from '../../../../shared/automation/protocol.js';
import type { AutomationSettings } from '../../../../shared/automation/contracts.js';
import { WorkerPool } from './worker-pool.js';
import { WorktreeCodeGraph } from './code-navigation.js';
import { HostSupervisorApplication } from './host-supervisor-application.js';

export class WorkerApplication {
  public async run(): Promise<void> {
    const child = process.argv.includes('--execution-child');
    if (child && (!process.send || !process.connected)) throw new Error('Исполнитель запускается только локальным host supervisor.');
    if (!child && !process.argv.includes('--once')) return new HostSupervisorApplication().run();
    const channel = new McpTrackerChannel(process.env.SAT_WORKSPACE ?? 'default');
    await channel.connect();
    const workerId = process.env.SAT_WORKER_ID ?? randomUUID();
    const settings = await channel.call<AutomationSettings>(AutomationTool.Settings);
    if (child && !process.connected) { await channel.close(); return; }
    const once = process.argv.includes('--once');
    const count = once ? 1 : Math.max(1, Math.min(8, settings.maxParallelRuns ?? 2));
    const pool = new WorkerPool(Array.from({ length: count }, (_, index) => new PipelineWorker(channel, `${workerId}-${index + 1}`, undefined, undefined, new WorktreeCodeGraph())));
    const projects = new ProjectWorker(channel, workerId);
    let projectTick: Promise<void> | undefined;
    const pollProjects = () => {
      if (!projectTick) projectTick = projects.tick().catch((error) => process.stderr.write(`Project worker: ${String(error)}\n`)).then(() => { projectTick = undefined; });
    };
    const stop = () => pool.stop();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const message = (value: unknown) => { if ((value as { type?: string })?.type === 'stop') stop(); };
    if (child) { process.on('message', message); process.on('disconnect', stop); }
    try {
      if (!child) await projects.tick();
      const timer = child ? undefined : setInterval(pollProjects, PROJECT_LIMITS.pollMs);
      try {
        process.stderr.write('Tracker worker connected. Waiting for explicitly queued runs.\n');
        if (child && process.connected) process.send?.({ type: 'ready' });
        await pool.run(once);
      } finally { clearInterval(timer); await projectTick; }
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      if (child) { process.off('message', message); process.off('disconnect', stop); if (process.connected) process.disconnect(); }
      await channel.close();
    }
  }
}
