import crossSpawn from 'cross-spawn';
import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PostOperation } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { TaskEnvironment } from '../runners/task-environment.js';
import { RuntimeCoordinator } from './runtime-coordinator.js';

interface Receipt { pid: number; started: string; }

export class PostOperationRunner {
  public constructor(private readonly executor: ProcessExecutor) {}

  public async run(op: PostOperation, cwd: string, common: string, signal: AbortSignal, onProgress?: (text: string) => void): Promise<void> {
    if (!op.background) {
      await this.executor.run({ ...op, cwd, signal, env: TaskEnvironment.create(), compactProgress: true, onProgress });
      return;
    }

    const key = createHash('sha256').update(JSON.stringify([op.command, op.args])).digest('hex');
    const directory = path.join(common, 'sat-runtime');
    const coordinator = new RuntimeCoordinator(path.join(directory, 'coordination.sqlite'));
    try {
      const lease = await coordinator.acquire('post-operation:' + key, signal);
      try {
        const file = path.join(directory, 'post-operation-' + key + '.json');
        let previous: Receipt | undefined;
        try { previous = JSON.parse(await readFile(file, 'utf8')) as Receipt; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (previous) {
          if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.started !== 'string' || !previous.started) {
            throw new Error('Некорректная запись фонового процесса SAT.');
          }
          if (await this.identity(previous.pid, signal) === previous.started) {
            onProgress?.(`Остановка предыдущего фонового процесса PID ${previous.pid}.\n`);
            await this.stop(previous.pid);
            const stopSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
            while (RuntimeCoordinator.isAlive(previous.pid)) await delay(100, undefined, { signal: stopSignal });
          }
          await unlink(file);
        }
        signal.throwIfAborted();
        const child = crossSpawn(op.command, op.args, {
          cwd, env: TaskEnvironment.create(), detached: true, windowsHide: true, stdio: 'ignore',
        });
        let startupError: Error | undefined;
        child.on('error', error => { startupError = error; });
        try {
          await delay(750, undefined, { signal });
          if (startupError) throw startupError;
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
            throw new Error('Фоновая пост-команда завершилась при запуске. Она должна держать сервер в своём процессе.');
          }
          const started = await this.identity(child.pid, signal);
          if (!started) throw new Error('Фоновая пост-команда завершилась до регистрации.');
          const temporary = file + '.tmp';
          await writeFile(temporary, JSON.stringify({ pid: child.pid, started }));
          await rename(temporary, file);
          child.unref();
          onProgress?.(`Фоновый процесс запущен, PID ${child.pid}.\n`);
        } catch (error) {
          if (child.pid && child.exitCode === null && child.signalCode === null) await this.stop(child.pid);
          throw error;
        }
      } finally { lease.release(); }
    } finally { coordinator.close(); }
  }

  private async identity(pid: number, signal: AbortSignal): Promise<string | undefined> {
    if (!RuntimeCoordinator.isAlive(pid)) return undefined;
    const windows = process.platform === 'win32';
    try {
      const output = await this.executor.run({
        command: windows ? 'powershell.exe' : 'ps',
        args: windows ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]
          : ['-p', String(pid), '-o', 'lstart='],
        cwd: process.cwd(), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!output.trim()) throw new Error('Не удалось определить время запуска процесса.');
      return output.trim();
    } catch (error) {
      if (!RuntimeCoordinator.isAlive(pid)) return undefined;
      throw error;
    }
  }

  private async stop(pid: number): Promise<void> {
    try {
      if (process.platform === 'win32') {
        await this.executor.run({ command: 'taskkill.exe', args: ['/PID', String(pid), '/T', '/F'],
          cwd: process.cwd(), signal: AbortSignal.timeout(10000) });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch (error) {
      if (RuntimeCoordinator.isAlive(pid)) throw error;
    }
  }
}
