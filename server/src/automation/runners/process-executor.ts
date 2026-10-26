import crossSpawn from 'cross-spawn';

export interface ProcessRequest {
  command: string; args: string[]; cwd: string; signal: AbortSignal;
  stdin?: string; env?: NodeJS.ProcessEnv; onProgress?: (text: string) => void;
  /** Maximum retained stdout characters; large structured catalogs need more than log tails. */
  maxOutputChars?: number;
  onStdout?: (text: string) => void;
}
const MAX_OUTPUT = 256 * 1024;

/** Executes argv without a shell, including npm shims on Windows. */
export class ProcessExecutor {
  public run(request: ProcessRequest): Promise<string> {
    request.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = crossSpawn(request.command, request.args, {
        cwd: request.cwd, env: request.env ?? process.env, shell: false,
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
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
        request.onProgress?.(value);
      });
      child.stderr?.on('data', (value: string) => {
        stderr = (stderr + value).slice(-MAX_OUTPUT);
        request.onProgress?.(value);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(request.stdin ?? '');
      child.once('error', (error) => { request.signal.removeEventListener('abort', abort); reject(error); });
      child.once('close', (code) => {
        request.signal.removeEventListener('abort', abort);
        if (request.signal.aborted) { reject(new Error('Execution cancelled or timed out.')); return; }
        if (code !== 0) { reject(new Error(`${request.command} failed (${code}): ${(stderr || stdout).slice(-6000)}`)); return; }
        resolve(stdout);
      });
    });
  }
}
