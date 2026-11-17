import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { RuntimeCoordinator, type RuntimeLease } from './runtime-coordinator.js';
import { TaskEnvironment } from '../runners/task-environment.js';
import { RunWorkspace } from './run-workspace.js';

/** Per-run mutable state and an OS-probed, host-coordinated application port. */
export class TaskRuntime {
  private constructor(public readonly env: NodeJS.ProcessEnv, private readonly coordinator: RuntimeCoordinator, private readonly lease: RuntimeLease, private readonly nxSocketDirectory?: string) {}
  public child(pid: number, active: boolean): void { this.lease.child(pid, active); }
  public async close(): Promise<void> {
    this.lease.release();
    this.coordinator.close();
    if (this.nxSocketDirectory) await fs.rmdir(this.nxSocketDirectory).catch(() => undefined);
  }
  public static async create(cwd: string, signal: AbortSignal): Promise<TaskRuntime> {
    const temporary = path.join(cwd, '.sat', 'tmp'); const cache = path.join(cwd, '.sat', 'cache');
    await RunWorkspace.localDirectory(cwd, '.sat/tmp'); await RunWorkspace.localDirectory(cwd, '.sat/cache');
    let nx = false;
    try { nx = (await fs.stat(path.join(cwd, 'nx.json'))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const coordinator = new RuntimeCoordinator(path.join(os.tmpdir(), 'simple-ai-tracker-runtime', 'ports.sqlite'));
    try {
      for (let attempt = 0; attempt < 32; attempt++) {
        signal.throwIfAborted();
        const server = net.createServer();
        const port = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)); });
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const lease = coordinator.tryAcquire(`port:${port}`);
        if (!lease) continue;
        try {
          // Nx plugin IPC has a shorter path limit than the worktree or its task temp directory.
          const nxSocketDirectory = nx ? await fs.mkdtemp(path.join(os.tmpdir(), 'sat-nx-')) : undefined;
          return new TaskRuntime({ ...TaskEnvironment.create(process.env), PORT: String(port), SAT_PORT: String(port),
            TMP: temporary, TEMP: temporary, TMPDIR: temporary, XDG_CACHE_HOME: cache,
            npm_config_cache: path.join(cache, 'npm'), NODE_COMPILE_CACHE: path.join(cache, 'node'),
            ...(nxSocketDirectory ? { NX_SOCKET_DIR: nxSocketDirectory, NX_DAEMON: 'false' } : {}),
          }, coordinator, lease, nxSocketDirectory);
        } catch (error) { lease.release(); throw error; }
      }
      throw new Error('Unable to reserve an isolated application port.');
    } catch (error) { coordinator.close(); throw error; }
  }
}
