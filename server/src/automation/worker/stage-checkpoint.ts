import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentOutcome } from '../../../../shared/automation/contracts.js';
import type { StageEvidence } from '../../../../shared/automation/work-order.js';

type Git = (args: string[]) => Promise<string>;
export interface StageResult {
  key: string; head: string; fingerprint: string; priorHead: string; priorStatus: string; outcome: AgentOutcome; checksComplete?: boolean; checks?: StageEvidence['checks'];
}

/** Durable completed-agent output; infrastructure retries must not call the model again. */
export class StageCheckpoint {
  private readonly file: string;
  public constructor(private readonly cwd: string, stage: number, revision: number, private readonly git: Git) {
    this.file = path.join(cwd, '.sat', `stage-${stage}-${revision}.json`);
  }
  public static key(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  public async load(key: string | string[]): Promise<StageResult | undefined> {
    let saved: StageResult;
    try { saved = JSON.parse(await fs.readFile(this.file, 'utf8')) as StageResult; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!(Array.isArray(key) ? key : [key]).includes(saved.key)) return undefined;
    if (saved.head !== (await this.git(['rev-parse', 'HEAD'])).trim() || saved.fingerprint !== await this.fingerprint()) {
      throw new Error('Completed stage checkpoint no longer matches worktree files/HEAD. Preserve and inspect the changes before restarting this stage.');
    }
    return saved;
  }
  public async save(result: StageResult): Promise<void> {
    result.head = (await this.git(['rev-parse', 'HEAD'])).trim();
    result.fingerprint = await this.fingerprint();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(result), 'utf8');
    await fs.rename(temporary, this.file);
  }
  private async fingerprint(): Promise<string> {
    const hash = createHash('sha256');
    // Hash actual changed files, not a possibly truncated textual/binary Git diff.
    hash.update(await this.git(['diff', '--cached', '--raw', '--no-abbrev', '--', '.', ':!.sat']));
    const tracked = await this.git(['diff', 'HEAD', '--name-only', '-z', '--', '.', ':!.sat']);
    const untracked = await this.git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':!.sat']);
    const files = [...new Set((tracked + untracked).split('\0').filter(Boolean))].sort();
    for (const file of files) {
      hash.update(JSON.stringify(file));
      const absolute = path.join(this.cwd, file);
      try {
        const stat = await fs.lstat(absolute);
        hash.update(stat.isSymbolicLink() ? await fs.readlink(absolute) : await fs.readFile(absolute));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted'); else throw error; }
    }
    return hash.digest('hex');
  }
}
