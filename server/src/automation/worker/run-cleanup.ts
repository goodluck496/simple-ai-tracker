import fs from 'node:fs/promises';
import path from 'node:path';
import { ProcessExecutor } from '../runners/process-executor.js';
import { RunWorkspace } from './run-workspace.js';
import { RuntimeCoordinator } from './runtime-coordinator.js';
import type { CleanupSpec, CleanupResult } from '../../../../shared/automation/cleanup.js';

/** Removes only registered worktrees whose generated path AND branch identify this run. */
export class RunCleanup {
  public constructor(private readonly executor = new ProcessExecutor()) {}
  public async execute(spec: CleanupSpec, signal: AbortSignal): Promise<CleanupResult> {
    if (!spec.merged && !spec.discard) throw new Error('Unmerged work requires explicit discard confirmation.');
    const location = await RunWorkspace.describe(spec.repository, spec.runId, spec.workspace, this.executor, signal);
    const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
    if (spec.directory && !same(location.directory, spec.directory)) throw new Error('Cleanup path is not this run’s managed workspace.');
    const coordinator = new RuntimeCoordinator(path.join(location.common, 'sat-runtime', 'coordination.sqlite'));
    let lease: Awaited<ReturnType<RuntimeCoordinator['acquire']>>;
    try { lease = await coordinator.acquire(`run:${spec.runId}`, signal); } catch (error) { coordinator.close(); throw error; }
    const result: CleanupResult = { paths: [], branches: [], retainedBranches: [] };
    try {
      if (spec.merged) {
        if (!spec.candidateSha || !/^[a-f0-9]{40,64}$/.test(spec.candidateSha)) throw new Error('Missing verified squash publication.');
        await location.git(['merge-base', '--is-ancestor', spec.candidateSha, `refs/heads/${spec.baseBranch}`]);
      }
      if (spec.children.some(c => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.key))) throw new Error('Invalid child identity.');
      const bases = [{ directory: location.directory, branch: `sat/${spec.runId}`, integration: spec.runId, sha: spec.sourceSha, published: spec.candidateSha },
        ...spec.children.map(c => ({ directory: `${location.directory}-child-${c.key}`, branch: `sat-child/${spec.runId}-${c.key}`, integration: `${spec.runId}-child-${c.key}`, sha: c.sourceSha, published: c.mergedSha }))];
      const entries = (await location.git(['worktree', 'list', '--porcelain', '-z'])).split('\0\0').filter(Boolean).map(block => {
        const fields = block.split('\0'); return { directory: fields.find(f => f.startsWith('worktree '))?.slice(9) ?? '',
          branch: fields.find(f => f.startsWith('branch refs/heads/'))?.slice(18) ?? '', sha: fields.find(f => f.startsWith('HEAD '))?.slice(5) ?? '' };
      });
      const owned = entries.filter(entry => bases.some(base => {
        if (same(entry.directory, base.directory)) return entry.branch === base.branch;
        const relative = entry.directory.slice(base.directory.length).replace(/\\/g, '/');
        const attempt = relative.match(/^-integration-(\d+)$/)?.[1];
        const suffix = entry.branch.slice(`sat-integration/${base.integration}-`.length);
        return same(entry.directory.slice(0, base.directory.length), base.directory) && /^-integration-\d+$/.test(relative)
          && entry.branch.startsWith(`sat-integration/${base.integration}-`)
          && (base.integration === spec.runId ? suffix === attempt : /^r\d+-\d+$/.test(suffix) && suffix.endsWith(`-${attempt}`));
      }));
      for (const entry of entries) {
        const generated = bases.some(base => same(entry.directory, base.directory)
          || same(entry.directory.slice(0, base.directory.length), base.directory) && /^-integration-\d+$/.test(entry.directory.slice(base.directory.length)));
        if (generated && !owned.includes(entry)) throw new Error('Managed worktree branch identity changed; retained.');
      }
      // Validate the complete set before deleting anything; no partial cleanup on a dirty sibling.
      for (const entry of owned) {
        const root = await fs.realpath(entry.directory);
        if (!same(root, entry.directory) || same(root, location.root) || (await fs.lstat(entry.directory)).isSymbolicLink()) throw new Error('Cleanup directory is redirected.');
        if (await fs.realpath(path.resolve(root, (await location.git(['rev-parse', '--git-common-dir'], root)).trim())) !== location.common) throw new Error('Worktree belongs to another repository.');
        if (!spec.discard && (await location.git(['status', '--porcelain', '--untracked-files=all'], root)).trim()) throw new Error('Dirty worktree retained; explicit discard is required.');
        const base = bases.find(b => b.branch === entry.branch);
        if (!spec.discard && base && base.sha !== entry.sha) throw new Error('Source branch changed after review; retained.');
      }
      for (const base of bases) {
        try { await fs.lstat(base.directory); if (!owned.some(e => same(e.directory, base.directory))) throw new Error('Unregistered or renamed worktree retained.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      for (const entry of owned.sort((a, b) => b.directory.length - a.directory.length)) {
        await this.unlinkReferences(entry.directory, signal);
        await location.git(['worktree', 'remove', '--force', '--', entry.directory]); result.paths.push(path.resolve(entry.directory));
      }
      const branches = (await location.git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'])).trim().split('\n');
      for (const line of branches) {
        const [branch, sha] = line.trim().split(' ');
        const base = bases.find(b => b.branch === branch);
        const integration = owned.some(e => e.branch === branch && branch.startsWith('sat-integration/'));
        if (!base && !integration) continue;
        const publication = [...bases].sort((a, b) => b.integration.length - a.integration.length).find(b => branch.startsWith(`sat-integration/${b.integration}-`))?.published;
        if (!spec.discard && !base && sha !== publication) { result.retainedBranches.push(branch); continue; }
        if (!spec.discard && base && base.sha !== sha) { result.retainedBranches.push(branch); continue; }
        await location.git(['branch', '-D', '--', branch]); result.branches.push(branch);
      }
      return result;
    } finally { lease.release(); coordinator.close(); }
  }
  private async unlinkReferences(directory: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); const info = await fs.lstat(file);
      if (info.isSymbolicLink()) await fs.unlink(file); // Never traverse node_modules junctions into shared caches.
      else if (info.isDirectory()) await this.unlinkReferences(file, signal);
    }
  }
}
