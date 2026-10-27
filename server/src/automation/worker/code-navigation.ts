import fs from 'node:fs/promises';
import path from 'node:path';
import { ProcessExecutor } from '../runners/process-executor.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';

/** A graph belongs to this worktree; never reuse the primary checkout's index. */
export class WorktreeCodeGraph {
  public constructor(private readonly executor = new ProcessExecutor()) {}
  public async prepare(cwd: string, signal: AbortSignal, progress: (text: string) => void): Promise<void> {
    let indexed = false;
    try {
      const stat = await fs.lstat(path.join(cwd, '.codegraph'));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CodeGraph index must be a private worktree directory.');
      indexed = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      await this.executor.run({ command: 'codegraph', args: indexed ? ['sync', '--quiet', cwd] : ['init', cwd], cwd, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), compactProgress: true });
    } catch (error) { throw new Error(`CodeGraph preparation failed before calling the agent. Check the host installation/worktree index; no model retry was started. ${CompactProgress.diagnostics(`Error: ${error instanceof Error ? error.message : String(error)}`)}`); }
    progress('Навигация по коду готова: CodeGraph текущей рабочей копии.\n');
  }
}
