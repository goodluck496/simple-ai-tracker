import fs from 'node:fs/promises';
import path from 'node:path';
import type { StageEvidence, WorkProgress } from '../../../../shared/automation/work-order.js';
import { RunWorkspace } from './run-workspace.js';

/** Last completed stage, independent of transient run.summary and raw execution logs. */
export class StageHandoff {
  private readonly file: string;
  public constructor(cwd: string, private readonly runId: string) { this.file = path.join(cwd, '.sat', 'stage-handoff.json'); }
  public async read(stage: number, revision: number, requirementsKey: string, sha: string): Promise<StageEvidence | undefined> {
    let saved: { runId: string; evidence: StageEvidence };
    try { saved = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Stage handoff is unreadable; preserved work requires inspection.'); }
    const evidence = saved.evidence;
    if (saved.runId !== this.runId || !evidence || !Array.isArray(evidence.changedFiles) || !Array.isArray(evidence.checks)
      || typeof evidence.summary !== 'string' || !Number.isSafeInteger(evidence.stage) || !Number.isSafeInteger(evidence.revision)) throw new Error('Invalid stage handoff; refusing unverified evidence.');
    if (evidence.revision > revision || (evidence.stage === stage && evidence.revision === revision)) return undefined;
    return { ...evidence, current: evidence.requirementsKey === requirementsKey && evidence.sha === sha };
  }
  public async save(evidence: StageEvidence): Promise<void> {
    await RunWorkspace.atomic(this.file, { runId: this.runId, evidence: { ...evidence, summary: evidence.summary.slice(0, 2400) } });
  }
  public async progress(requirementsKey: string, stepIds: string[]): Promise<WorkProgress | undefined> {
    const file = path.join(path.dirname(this.file), 'work-progress.json');
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16000) return { state: 'unreadable' };
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.workOrderKey !== requirementsKey) return { state: 'stale' };
      if (!Array.isArray(saved.completedSteps) || saved.completedSteps.some((id: unknown) => typeof id !== 'string' || !stepIds.includes(id))
        || (saved.nextStep !== undefined && !stepIds.includes(saved.nextStep)) || typeof saved.summary !== 'string') return { state: 'unreadable' };
      return { state: 'hints', completedSteps: [...new Set<string>(saved.completedSteps)], nextStep: saved.nextStep, summary: saved.summary.slice(0, 1200) };
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { state: 'unreadable' }; }
  }
}
