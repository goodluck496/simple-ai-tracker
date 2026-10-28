export interface CleanupSpec {
  runId: string; workspace: string; repository: string; directory?: string;
  baseBranch: string; sourceSha?: string; candidateSha?: string;
  children: { key: string; sourceSha?: string; mergedSha?: string }[];
  merged: boolean; discard: boolean;
}
export interface CleanupResult { paths: string[]; branches: string[]; retainedBranches: string[]; }
export interface CleanupState { state: 'queued' | 'failed' | 'completed'; requestId?: string; error?: string; result?: CleanupResult; }
