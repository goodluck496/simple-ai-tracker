/** Cohort: first startedAt in [from, to); outcomes reflect the time of reading. */
export interface ImprovementPeriod { from: string; to: string; }

export interface ImprovementRatio { numerator: number; denominator: number; }

/** A safe summary; the source event remains authoritative evidence. */
export interface ImprovementOccurrence {
  id: string;
  runId: string;
  eventId: number;
  /** Context of the source event, never inferred from the run's current revision. */
  attempt?: number;
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
