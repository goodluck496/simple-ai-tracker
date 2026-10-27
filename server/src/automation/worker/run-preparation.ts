import fs from 'node:fs/promises';
import path from 'node:path';
import type { AutomationSettings } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { DependencyPool } from './dependency-pool.js';
import { WorktreePreparation } from './worktree-preparation.js';

export interface DependencyResult { mode: 'isolated' | 'linked'; key?: string; note?: string; }
export class RunPreparation {
  private readonly pool: DependencyPool;
  public constructor(private readonly executor: ProcessExecutor, common: string, private readonly settings: AutomationSettings) {
    this.pool = new DependencyPool(common, executor);
  }
  public close(): void { this.pool.close(); }
  public detach(cwd: string): Promise<void> { return this.pool.detach(cwd); }
  public child(pid: number, active: boolean): void { this.pool.child(pid, active); }
  public async prepare(cwd: string, signal: AbortSignal, progress: (text: string) => void): Promise<DependencyResult> {
    const marker = path.join(cwd, '.sat', 'isolated-dependencies');
    let forced = false; try { await fs.access(marker); forced = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const linked = await this.pool.state(cwd);
    if (linked && linked.signature !== await this.pool.signature(cwd)) {
      await this.pool.detach(cwd); forced = true; await fs.writeFile(marker, 'manifest changed\n', 'utf8');
    }
    if (!forced && this.settings.dependencyMode === 'linked' && !this.settings.setup.length) {
      const result = await this.pool.link(cwd, signal, progress);
      if (result.key) {
        const missing = await new WorktreePreparation(this.executor).inspect(cwd);
        if (missing.length) throw new Error(`Immutable cache is incomplete: ${missing.join(', ')}`);
        return { mode: 'linked', key: result.key };
      }
      await this.pool.detach(cwd);
      if (linked) await fs.writeFile(marker, 'installation settings changed\n', 'utf8');
      await new WorktreePreparation(this.executor).prepare(cwd, this.settings.setup, signal, progress);
      return { mode: 'isolated', note: result.reason };
    }
    await this.pool.detach(cwd);
    await new WorktreePreparation(this.executor).prepare(cwd, this.settings.setup, signal, progress);
    return { mode: 'isolated', note: forced ? 'Manifest changed; dependencies detached and installed privately.' : undefined };
  }
}
