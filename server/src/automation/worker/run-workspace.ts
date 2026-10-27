import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProcessExecutor } from '../runners/process-executor.js';

export class RunWorkspace {
  public static async describe(repository: string, runId: string, workspace: string, executor: ProcessExecutor, signal: AbortSignal) {
    if (!/^[\w-]+$/.test(runId)) throw new Error('Invalid run identity.');
    const root = await fs.realpath(repository);
    const git = (args: string[], cwd = root) => executor.run({ command: 'git', args, cwd, signal });
    if (await fs.realpath((await git(['rev-parse', '--show-toplevel'])).trim()) !== root) throw new Error('Repository path must point to the Git root.');
    const common = await fs.realpath(path.resolve(root, (await git(['rev-parse', '--git-common-dir'])).trim()));
    const project = createHash('sha256').update(process.platform === 'win32' ? common.toLowerCase() : common).digest('hex').slice(0, 16);
    const parent = path.join(path.dirname(root), '.sat-worktrees');
    const directory = path.join(parent, project, workspace.replace(/[^a-z0-9_-]/gi, '_'), runId);
    const legacy = path.join(parent, runId);
    let cwd = directory;
    try {
      await fs.access(legacy);
      const legacyCommon = await fs.realpath(path.resolve(legacy, (await git(['rev-parse', '--git-common-dir'], legacy)).trim()));
      if (legacyCommon !== common) throw new Error('Legacy worktree belongs to a different repository.');
      cwd = legacy;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { root, common, directory: cwd, branch: `sat/${runId}`, git };
  }
  public static async ignoreRuntime(common: string): Promise<void> {
    const file = path.join(common, 'info', 'exclude');
    await fs.mkdir(path.dirname(file), { recursive: true });
    let current = '';
    try { current = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!current.split(/\r?\n/).includes('/.sat/')) await fs.appendFile(file, '\n/.sat/\n', 'utf8');
  }
  public static async atomic(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, 'w');
    try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  }
}
