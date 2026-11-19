/** Cohort: first startedAt in [from, to); outcomes reflect the time of reading. */
export interface ImprovementPeriod { from: string; to: string; }

export interface ImprovementRatio { numerator: number; denominator: number; }

export type CheckOutcome =
  | { kind: 'exit'; code: number }
  | { kind: 'launch_error' }
  | { kind: 'cancelled' }
  | { kind: 'unknown' };

export interface BrowserCheckResult {
  criterionId: string;
  action: string;
  assertion: string;
  actual: string;
  screenshot: string;
  imageDigest: string;
}

export interface CheckExecution {
  id: string;
  runId: string;
  attempt: number;
  stage: number;
  phase: 'stage' | 'candidate';
  revision: number;
  sha: string;
  fingerprint: string;
  position: number;
  command: string;
  args: string[];
  outcome: CheckOutcome;
  at: string;
  browserResults?: BrowserCheckResult[];
}

export interface CheckEvidence extends CheckExecution {
  eventId: number;
}

/** A safe summary; the source event remains authoritative evidence. */
export interface ImprovementOccurrence {
  id: string;
  runId: string;
  eventId: number;
  /** Context of the source event, never inferred from the run's current revision. */
  attempt?: number;
  revision?: number;
  sha?: string;
  taskId: string;
  at: string;
  phase: string;
  role?: string;
  executor?: string;
  fact: string;
  confirmedCause?: string;
  recommendation?: string;
  improvementTaskId?: string;
  reviewState: 'new' | 'repeated' | 'repeated_after_done';
  technicalRejection?: boolean;
}

export interface ImprovementMetrics {
  period: ImprovementPeriod;
  asOf: string;
  runs: number;
  tasks: number;
  technical: ImprovementRatio;
  acceptance: ImprovementRatio;
  awaitingAcceptance: number;
  acceptedFirstAttempt: number;
  active: number;
  stopped: number;
  noRequiredChecks: number;
  unknown: number;
  occurrences: ImprovementOccurrence[];
}
