import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { ExecutionStatus } from '../../../../shared/automation/project.js';

export interface ExecutionControl { status(): ExecutionStatus; start(): Promise<ExecutionStatus>; stop(): Promise<ExecutionStatus>; }

/** Only this fixed, locally configured child can be controlled by remote start/stop. */
export class ExecutionSupervisor implements ExecutionControl {
  private child?: ChildProcess;
  private current: ExecutionStatus = { state: 'stopped', hostName: os.hostname() };
  private operation?: Promise<ExecutionStatus>;
  public constructor(private readonly entry: string, private readonly args: string[], private readonly env: NodeJS.ProcessEnv,
    private readonly track: (pid: number, active: boolean) => void = () => undefined, private readonly timeoutMs = 15000) {}
  public status(): ExecutionStatus { return { ...this.current }; }
  public start(): Promise<ExecutionStatus> {
    if (this.operation) return this.operation.then(() => this.start());
    if (this.child && this.current.state === 'running') return Promise.resolve(this.status());
    if (this.child) return Promise.reject(new Error('Предыдущий исполнитель ещё не завершился.'));
    return this.perform(async () => {
      this.current = { state: 'starting', hostName: os.hostname() };
      const child = spawn(process.execPath, [this.entry, ...this.args], { env: this.env, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      this.child = child;
      child.once('error', error => { if (!child.pid && this.child === child) { this.child = undefined; this.current = { state: 'stopped', error: String(error), hostName: os.hostname() }; } });
      if (child.pid) { this.current.pid = child.pid; this.track(child.pid, true); }
      child.on('exit', (code, signal) => {
        if (child.pid) this.track(child.pid, false);
        if (this.child !== child) return;
        const expected = this.current.state === 'stopping';
        this.child = undefined; this.current = { state: 'stopped', hostName: os.hostname(), ...(expected ? {} : { error: `Исполнитель завершился: ${signal ?? code}.` }) };
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error('Исполнитель не подтвердил готовность.')), this.timeoutMs);
          const message = (value: unknown) => { if ((value as { type?: string })?.type === 'ready') finish(); };
          const error = (cause: Error) => finish(cause);
          const exited = () => finish(new Error('Исполнитель завершился до подключения.'));
          const finish = (cause?: Error) => { clearTimeout(timer); child.off('message', message); child.off('error', error); child.off('exit', exited); cause ? reject(cause) : resolve(); };
          child.on('message', message); child.once('error', error); child.once('exit', exited);
        });
        this.current = { state: 'running', pid: child.pid, hostName: os.hostname() }; return this.status();
      } catch (error) {
        this.killOwned(child); this.current = { state: 'stopped', error: String(error), hostName: os.hostname() }; throw error;
      }
    });
  }
  public stop(): Promise<ExecutionStatus> {
    if (this.operation) return this.operation.catch(() => this.status()).then(() => this.stop());
    return this.perform(async () => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return this.status();
      this.current = { ...this.current, state: 'stopping' };
      await new Promise<void>(resolve => {
        const force = setTimeout(() => this.killOwned(child), this.timeoutMs);
        const deadline = setTimeout(finish, this.timeoutMs + 3000);
        function finish() { clearTimeout(force); clearTimeout(deadline); child?.off('exit', finish); resolve(); }
        child.once('exit', finish);
        if (child.connected) child.send({ type: 'stop' }, error => { if (error) this.killOwned(child); });
        else this.killOwned(child);
      });
      if (this.child === child) throw new Error('Не удалось подтвердить остановку исполнителя.');
      return this.status();
    });
  }
  private perform(action: () => Promise<ExecutionStatus>): Promise<ExecutionStatus> {
    const operation = action(); this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; }).catch(() => undefined);
    return operation;
  }
  private killOwned(child: ChildProcess): void {
    if (child !== this.child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  }
}
