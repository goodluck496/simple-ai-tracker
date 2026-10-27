import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessExecutor } from '../runners/process-executor.js';

/** Only applied to worker-owned caches, never the source repository's node_modules. */
export class ImmutableDependencies {
  public constructor(private readonly executor: ProcessExecutor) {}
  public async inspect(root: string): Promise<string[]> {
    const base = await fs.realpath(root); const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await fs.realpath(file); const relative = path.relative(base, target);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Dependency cache contains an external link; sharing refused.');
        } else if (entry.isDirectory()) await walk(file); else if (entry.isFile()) files.push(file);
      }
    };
    await walk(root); return files;
  }
  public async protect(root: string, signal: AbortSignal): Promise<string | undefined> {
    await this.inspect(root);
    let sid: string | undefined;
    if (process.platform === 'win32') {
      const owner = await this.executor.run({ command: 'whoami', args: ['/user', '/fo', 'csv', '/nh'], cwd: root, signal });
      sid = owner.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error('Cannot determine cache owner SID; sharing refused.');
      await this.executor.run({ command: 'icacls', args: [root, '/deny', `*${sid}:(OI)(CI)(WD,AD,WEA,WA,DE,DC)`, '/T', '/C', '/L', '/Q'], cwd: path.dirname(root), signal });
    } else await this.permissions(root, false);
    await this.verify(root); return sid;
  }
  public async verify(root: string): Promise<void> {
    const denied = (error: unknown) => ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
    const probe = path.join(root, `.sat-write-probe-${randomUUID()}`);
    let writable = false;
    try { await fs.writeFile(probe, 'probe'); writable = true; } catch (error) { if (!denied(error)) throw error; }
    if (writable) { await fs.unlink(probe); throw new Error('Cache directory is writable; sharing refused.'); }
    const files = await this.inspect(root);
    for (const file of files.filter(f => path.basename(f) === 'package.json' || path.basename(f) === '.package-lock.json')) {
      let handle;
      try { handle = await fs.open(file, 'r+'); } catch (error) { if (!denied(error)) throw error; }
      if (handle) { await handle.close(); throw new Error('Dependency package is writable; sharing refused.'); }
    }
  }
  public async unprotect(root: string, sid: string | undefined, signal: AbortSignal): Promise<void> {
    await this.inspect(root);
    if (process.platform === 'win32') {
      if (!sid) {
        const owner = await this.executor.run({ command: 'whoami', args: ['/user', '/fo', 'csv', '/nh'], cwd: path.dirname(root), signal });
        sid = owner.match(/S-1-\d+(?:-\d+)+/)?.[0];
      }
      if (!sid) throw new Error('Cannot restore managed cache permissions.');
      await this.executor.run({ command: 'icacls', args: [root, '/remove:d', `*${sid}`, '/T', '/C', '/L', '/Q'], cwd: path.dirname(root), signal });
    } else await this.permissions(root, true);
  }
  private async permissions(root: string, writable: boolean): Promise<void> {
    const stat = await fs.lstat(root); if (stat.isSymbolicLink()) return;
    await fs.chmod(root, writable ? stat.mode | 0o200 : stat.mode & ~0o222);
    if (stat.isDirectory()) for (const entry of await fs.readdir(root)) await this.permissions(path.join(root, entry), writable);
  }
}
