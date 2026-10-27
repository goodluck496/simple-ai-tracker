import crossSpawn from 'cross-spawn';
import { ExecutionScope } from './execution-scope.js';
import { TaskEnvironment } from './task-environment.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';

export interface ProcessRequest {
  command: string; args: string[]; cwd: string; signal: AbortSignal;
  stdin?: string; env?: NodeJS.ProcessEnv; onProgress?: (text: string) => void;
  /** Maximum retained stdout characters; large structured catalogs need more than log tails. */
  maxOutputChars?: number;
  compactProgress?: boolean;
  onStdout?: (text: string) => void;
}
const MAX_OUTPUT = 256 * 1024;

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
        request.onStdout?.(value);
        stdout = (stdout + value).slice(-(request.maxOutputChars ?? MAX_OUTPUT));
        if (!request.compactProgress) request.onProgress?.(value);
      });
      child.stderr?.on('data', (value: string) => {
        stderr = (stderr + value).slice(-MAX_OUTPUT);
        if (!request.compactProgress) request.onProgress?.(value);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(request.stdin ?? '');
      child.once('error', (error) => { request.signal.removeEventListener('abort', abort); reject(error); });
      child.once('close', (code) => {
        try { if (child.pid) scope?.child?.(child.pid, false); } catch (error) { observerError ??= error; }
        request.signal.removeEventListener('abort', abort);
        if (observerError) { reject(observerError); return; }
        if (request.signal.aborted) { reject(new Error('Execution cancelled or timed out.')); return; }
        const diagnostic = request.compactProgress ? CompactProgress.diagnostics(stderr || stdout) : (stderr || stdout).slice(-6000);
        if (request.compactProgress) request.onProgress?.(`Команда завершена: exit ${code}.\n${code !== 0 ? diagnostic + '\n' : ''}`);
        if (code !== 0) { reject(new Error(`${request.command} failed (${code}): ${diagnostic}`)); return; }
        resolve(stdout);
      });
      try { if (child.pid) scope?.child?.(child.pid, true); } catch (error) { observerError = error; abort(); }
    });
  }
}
