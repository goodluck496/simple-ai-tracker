import crossSpawn from 'cross-spawn';
import { ExecutionScope } from './execution-scope.js';
import { TaskEnvironment } from './task-environment.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';
import { runFailure } from '../../../../shared/automation/run-failure.js';

export interface ProcessRequest {
  command: string; args: string[]; cwd: string; signal: AbortSignal;
  stdin?: string; env?: NodeJS.ProcessEnv; onProgress?: (text: string) => void;
  /** Maximum retained stdout characters; large structured catalogs need more than log tails. */
  maxOutputChars?: number;
  compactProgress?: boolean;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}
const MAX_OUTPUT = 256 * 1024;
export const PROCESS_PROGRESS_MS = 15000;

/** Keep subprocess evidence available to agent tools without putting it in progress logs. */
export class ProcessExecutionError extends Error {
  public constructor(message: string, public readonly exitCode: number | null,
    public readonly stdout: string, public readonly stderr: string) { super(message); }
}

/** Executes argv without a shell, including npm shims on Windows. */
export class ProcessExecutor {
  public run(request: ProcessRequest): Promise<string> {
    request.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const scope = ExecutionScope.current;
      const environment = request.env ?? (scope?.env ? TaskEnvironment.create(scope.env) : process.env);
      const child = crossSpawn(request.command, request.args, {
        cwd: request.cwd, env: /^git(?:\.exe)?$/i.test(request.command) ? TaskEnvironment.git(environment) : environment, shell: false,
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      let observerError: unknown;
      let stdout = ''; let stderr = '';
      const startedAt = Date.now(); let lastOutputAt = startedAt;
      const label = CompactProgress.command(request.command, request.args);
      const elapsed = (at: number) => `${Math.floor((Date.now() - at) / 1000)} с`;
      if (request.compactProgress) request.onProgress?.(`Выполняется: ${label}.\n`);
      const progressTimer = request.compactProgress && request.onProgress ? setInterval(() => {
        const diagnostic = CompactProgress.liveOutput(stderr || stdout);
        request.onProgress?.(`Выполняется: ${label} · прошло ${elapsed(startedAt)} · без вывода ${elapsed(lastOutputAt)}. Процент команды неизвестен.\n${diagnostic ? diagnostic + '\n' : ''}`);
      }, PROCESS_PROGRESS_MS) : undefined;
      const abort = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const killer = crossSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      };
      request.signal.addEventListener('abort', abort, { once: true });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (value: string) => {
        lastOutputAt = Date.now();
        request.onStdout?.(value);
        stdout = (stdout + value).slice(-(request.maxOutputChars ?? MAX_OUTPUT));
        if (!request.compactProgress) request.onProgress?.(value);
      });
      child.stderr?.on('data', (value: string) => {
        lastOutputAt = Date.now();
        request.onStderr?.(value);
        stderr = (stderr + value).slice(-MAX_OUTPUT);
        if (!request.compactProgress) request.onProgress?.(value);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(request.stdin ?? '');
      child.once('error', (error) => { clearInterval(progressTimer); request.signal.removeEventListener('abort', abort); reject(error); });
      child.once('close', (code) => {
        clearInterval(progressTimer);
        try { if (child.pid) scope?.child?.(child.pid, false); } catch (error) { observerError ??= error; }
        request.signal.removeEventListener('abort', abort);
        if (observerError) { reject(observerError); return; }
        if (request.signal.aborted) { reject(new Error('Execution cancelled or timed out.')); return; }
        const network = code !== 0 ? runFailure(stderr + '\n' + stdout) : undefined;
        const diagnostic = request.compactProgress
          ? network?.code ? `${network.title} (${network.code}).` : CompactProgress.diagnostics(stderr || stdout)
          : (stderr || stdout).slice(-6000);
        if (request.compactProgress) request.onProgress?.(`Команда: ${CompactProgress.command(request.command, request.args)} → exit ${code}.\n${code !== 0 ? diagnostic + '\n' : CompactProgress.success(stdout).map(line => line + '\n').join('')}`);
        if (code !== 0) { reject(new ProcessExecutionError(`${request.command} failed (${code}): ${diagnostic}`, code, stdout, stderr)); return; }
        resolve(stdout);
      });
      try { if (child.pid) scope?.child?.(child.pid, true); } catch (error) { observerError = error; abort(); }
    });
  }
}
