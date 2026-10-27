import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { RuntimeCoordinator, type RuntimeLease } from './runtime-coordinator.js';
import { TaskEnvironment } from '../runners/task-environment.js';
import { RunWorkspace } from './run-workspace.js';

/** Per-run mutable state and an OS-probed, host-coordinated application port. */
export class TaskRuntime {
  private constructor(public readonly env: NodeJS.ProcessEnv, private readonly coordinator: RuntimeCoordinator, private readonly lease: RuntimeLease) {}
  public child(pid: number, active: boolean): void { this.lease.child(pid, active); }
  public close(): void { this.lease.release(); this.coordinator.close(); }
  public static async create(cwd: string, signal: AbortSignal): Promise<TaskRuntime> {
    const temporary = path.join(cwd, '.sat', 'tmp'); const cache = path.join(cwd, '.sat', 'cache');
    await RunWorkspace.localDirectory(cwd, '.sat/tmp'); await RunWorkspace.localDirectory(cwd, '.sat/cache');
    const coordinator = new RuntimeCoordinator(path.join(os.tmpdir(), 'simple-ai-tracker-runtime', 'ports.sqlite'));
    try {
      for (let attempt = 0; attempt < 32; attempt++) {
        signal.throwIfAborted();
        const server = net.createServer();
        const port = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)); });
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const lease = coordinator.tryAcquire(`port:${port}`);
        if (!lease) continue;
        return new TaskRuntime({ ...TaskEnvironment.create(process.env), PORT: String(port), SAT_PORT: String(port),
          TMP: temporary, TEMP: temporary, TMPDIR: temporary, XDG_CACHE_HOME: cache,
          npm_config_cache: path.join(cache, 'npm'), NODE_COMPILE_CACHE: path.join(cache, 'node') }, coordinator, lease);
      }
      throw new Error('Unable to reserve an isolated application port.');
    } catch (error) { coordinator.close(); throw error; }
  }
}
