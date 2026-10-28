import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { McpTrackerChannel } from './mcp-client.js';
import { ProjectWorker } from './project-worker.js';
import { ExecutionSupervisor } from './execution-supervisor.js';
import { RuntimeCoordinator } from './runtime-coordinator.js';
import { AutomationTool } from '../../../../shared/automation/protocol.js';
import { PROJECT_LIMITS, type HostStatus } from '../../../../shared/automation/project.js';

/** Permanent local bridge; backend requests can only start/stop its own executor. */
export class HostSupervisorApplication {
  public async run(): Promise<void> {
    const workspace = process.env.SAT_WORKSPACE ?? 'default'; const id = process.env.SAT_WORKER_ID ?? randomUUID();
    const key = createHash('sha256').update(JSON.stringify([workspace, process.env.SAT_MCP_COMMAND, process.env.SAT_MCP_ARGS])).digest('hex');
    const home = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'SimpleAiTracker') : path.join(os.homedir(), '.cache', 'simple-ai-tracker');
    const coordinator = new RuntimeCoordinator(path.join(home, 'hosts', key, 'coordination.sqlite'));
    const lease = coordinator.tryAcquire('host');
    if (!lease) { coordinator.close(); throw new Error('Локальный хост этого пространства уже запущен.'); }
    const controller = new AbortController(); const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const execution = new ExecutionSupervisor(path.resolve(process.argv[1]), [...process.argv.slice(2), '--execution-child'],
      { ...process.env, SAT_WORKER_ID: `${id}:executor` }, (pid, active) => lease.child(pid, active));
    let initial = true; let resumeExecution = false; let wantExecution = false;
    const control = { status: () => execution.status(), async start() { wantExecution = true; return execution.start(); }, async stop() { wantExecution = false; return execution.stop(); } };
    try {
      while (!controller.signal.aborted) {
        const channel = new McpTrackerChannel(workspace);
        try {
          await channel.connect();
          const previous = await channel.call<HostStatus>(AutomationTool.HostStatus);
          if (initial) {
            wantExecution = previous.executionDesired ?? !(previous.execution?.state === 'stopped' && !previous.execution.error && previous.execution.hostName === os.hostname());
            resumeExecution = wantExecution;
            initial = false;
          } else if (previous.executionDesired !== undefined) wantExecution = previous.executionDesired;
          const projects = new ProjectWorker(channel, id, undefined, undefined, control);
          await projects.tick();
          if (resumeExecution && wantExecution) await execution.start().catch(error => process.stderr.write(`Executor start: ${String(error)}\n`));
          resumeExecution = false;
          process.stderr.write('Tracker host supervisor connected. Worker execution can be controlled from UI.\n');
          while (!controller.signal.aborted) {
            await projects.tick();
            await delay(PROJECT_LIMITS.pollMs, undefined, { signal: controller.signal });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            resumeExecution = wantExecution;
            process.stderr.write(`Host connection: ${String(error)}; reconnecting.\n`);
            await execution.stop().catch(cause => process.stderr.write(`${String(cause)}\n`));
          }
        } finally { await channel.close().catch(() => undefined); }
        if (!controller.signal.aborted) await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    } finally {
      await execution.stop().catch(error => process.stderr.write(`${String(error)}\n`));
      process.off('SIGINT', stop); process.off('SIGTERM', stop); lease.release(); coordinator.close();
    }
  }
}
