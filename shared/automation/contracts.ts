import { TaskStatus } from '../tasks/status.js';
import type { RunPhase } from './queue.js';

export const AgentRole = { Analyst: 'analyst', Developer: 'developer', Tester: 'tester', Reviewer: 'reviewer', Designer: 'designer', VisualValidator: 'visual-validator' } as const;
export type AgentRole = typeof AgentRole[keyof typeof AgentRole];
export const AGENT_ROLES = Object.values(AgentRole);
export const RunnerId = { Codex: 'codex', ClaudeCode: 'claude-code', OpenCode: 'opencode', DeepSeekHarness: 'deepseek-harness', Antigravity: 'antigravity', ModelApi: 'model-api', Custom: 'custom' } as const;
export type RunnerId = typeof RunnerId[keyof typeof RunnerId];
export const RUNNER_IDS = Object.values(RunnerId);
export const ProviderKind = { Native: 'native', Ollama: 'ollama', OpenAICompatible: 'openai-compatible' } as const;
export type ProviderKind = typeof ProviderKind[keyof typeof ProviderKind];
export const PROVIDER_KINDS = Object.values(ProviderKind);
export const ReasoningEffort = { None: 'none', Low: 'low', Medium: 'medium', High: 'high' } as const;
export type ReasoningEffort = typeof ReasoningEffort[keyof typeof ReasoningEffort];
export const REASONING_EFFORTS = Object.values(ReasoningEffort);
export const MergePolicy = { Manual: 'manual', Local: 'local' } as const;
export type MergePolicy = typeof MergePolicy[keyof typeof MergePolicy];
export const MERGE_POLICIES = Object.values(MergePolicy);
export const RunStatus = { Queued: 'queued', Running: 'running', Integrating: 'integrating', MergeBlocked: 'merge_blocked', Waiting: 'waiting', Review: 'review', Failed: 'failed', Cancelled: 'cancelled', Interrupted: 'interrupted', Merged: 'merged' } as const;
export type RunStatus = typeof RunStatus[keyof typeof RunStatus];
export const AgentVerdict = { Pass: 'pass', ChangesRequested: 'changes_requested', Questions: 'questions', Blocked: 'blocked' } as const;
export type AgentVerdict = typeof AgentVerdict[keyof typeof AgentVerdict];
export const AGENT_VERDICTS = Object.values(AgentVerdict);
export const AUTOMATION_START_TASK_STATUSES: readonly TaskStatus[] = [TaskStatus.Backlog, TaskStatus.Planning, TaskStatus.Ready];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [RunStatus.Queued, RunStatus.Running, RunStatus.Integrating, RunStatus.Waiting];
export const RESUMABLE_RUN_STATUSES: readonly RunStatus[] = [RunStatus.Waiting, RunStatus.Failed, RunStatus.Interrupted, RunStatus.Cancelled, RunStatus.MergeBlocked];
export const OWNED_RUN_STATUSES: readonly RunStatus[] = [RunStatus.Running, RunStatus.Integrating, RunStatus.Review];
export const RunAction = { Cancel: 'cancel', Resume: 'resume', Restart: 'restart' } as const;
export type RunAction = typeof RunAction[keyof typeof RunAction];
export const WRITABLE_AGENT_ROLES: readonly AgentRole[] = [AgentRole.Developer, AgentRole.Designer];
export const READ_ONLY_AGENT_ROLES: readonly AgentRole[] = [AgentRole.Analyst, AgentRole.Tester, AgentRole.Reviewer, AgentRole.VisualValidator];
export const EVIDENCE_AGENT_ROLES: readonly AgentRole[] = [AgentRole.Tester, AgentRole.Reviewer, AgentRole.VisualValidator];
export const REQUIRED_PIPELINE_ROLES: readonly AgentRole[] = [AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer];
export const AUTOMATION_LIMITS = { timeoutMinutes: { min: 1, max: 240, default: 30 }, revisions: { min: 0, max: 10, default: 1 }, modelToolTurns: 40, imageBytes: 4 * 1024 * 1024, eventTextLength: 12000 } as const;
export const AUTOMATION_TIMING = { pollMs: 5000, heartbeatMs: 15000, leaseMs: 90000 } as const;

export interface ModelConnection {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** Environment variable on the worker, never the credential itself. */
  credentialEnv?: string;
  supportsImages: boolean;
  reasoningEffort?: ReasoningEffort;
}

export interface AgentProfile {
  id: string;
  role: AgentRole;
  runner: RunnerId;
  connectionId: string;
  model: string;
  instructions: string;
  /** Native profile configured on the worker (e.g. DeepSeek Harness). */
  nativeProfile?: string;
  /** Custom bridge executable and argv; placeholders are individual argv values. */
  command?: string;
  args?: string[];
}

export interface CheckCommand { command: string; args: string[]; }

export interface AutomationSettings {
  repositoryPath: string;
  baseBranch: string;
  connections: ModelConnection[];
  agents: AgentProfile[];
  pipeline: string[];
  checks: CheckCommand[];
  setup: CheckCommand[];
  artifactPaths: string[];
  timeoutMinutes: number;
  maxRevisions: number;
  maxAgentCalls?: number;
  maxInputTokens?: number;
  maxRunMinutes?: number;
  maxParallelRuns?: number;
  dependencyMode?: 'isolated' | 'linked';
  maxMergeAttempts?: number;
  resolveConflicts?: boolean;
  maxResolverCalls?: number;
  resolverTimeoutMinutes?: number;
  maxResolverToolCalls?: number;
  mergePolicy: MergePolicy;
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  repositoryPath: '', baseBranch: 'main', connections: [], agents: [], pipeline: [], checks: [], setup: [],
  artifactPaths: [], timeoutMinutes: AUTOMATION_LIMITS.timeoutMinutes.default, maxRevisions: 1, maxAgentCalls: 6, maxInputTokens: 500000, maxRunMinutes: 20, mergePolicy: MergePolicy.Manual,
  maxParallelRuns: 2, dependencyMode: 'isolated', maxMergeAttempts: 2, resolveConflicts: true,
  maxResolverCalls: 1, resolverTimeoutMinutes: 3, maxResolverToolCalls: 16,
};
export const DEFAULT_CHECK_COMMAND: CheckCommand = { command: 'npm', args: ['test'] };
export const DEFAULT_SETUP_COMMAND: CheckCommand = { command: 'npm', args: ['ci'] };
export interface AgentRun {
  integrationSourceSha?: string;
  mergeReviewRequired?: boolean;
  checkout?: { repositoryRoot: string; worktreePath: string; baseSha: string; dependencyMode: 'isolated' | 'linked'; dependencyKey?: string; dependencyNote?: string };
  integration?: IntegrationInfo;
  mergeMessage?: string;
  budgetElapsedMs?: number;
  budgetUpdatedAt?: string;
  usageAttempts?: import('./token-usage.js').UsageAttempt[];
  usageIncomplete?: boolean;
  attemptStartedAt?: string;
  phase?: RunPhase;
  phaseStartedAt?: string;
  heartbeatAt?: string;
  progressAt?: string;
  lastMessage?: string;
  restartedFromId?: string;
  id: string;
  taskId: string;
  status: RunStatus;
  stage: number;
  revision: number;
  workerId: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  settings: AutomationSettings;
  createdAt: string;
  updatedAt: string;
  branch: string | null;
  commitSha: string | null;
  summary: string;
}
export interface IntegrationInfo {
  state: 'preparing' | 'resolving' | 'checking' | 'ready' | 'publishing' | 'merged' | 'blocked';
  sourceSha: string; baseSha: string; candidateSha?: string; targetBranch: string;
  worktreePath: string; attempt: number; error?: string; noChanges?: boolean;
}
export interface RunEvent { id: number; runId: string; at: string; kind: string; text: string; }
export interface AgentOutcome {
  commitMessage?: string;
  verdict: AgentVerdict;
  summary: string;
  questions?: string[];
  plan?: string;
}

export interface AgentJob {
  maxToolCalls?: number;
  onUsage?: (usage: import('./token-usage.js').TokenUsage) => void;
  runId: string;
  cwd: string;
  prompt: string;
  profile: AgentProfile;
  connection: ModelConnection;
  settings: AutomationSettings;
  signal: AbortSignal;
}
export interface RunnerResult { text: string; sessionId?: string; usage?: import('./token-usage.js').TokenUsage; }
export interface AgentRunner {
  readonly id: RunnerId;
  run(job: AgentJob, onProgress: (text: string) => void): Promise<RunnerResult>;
}
