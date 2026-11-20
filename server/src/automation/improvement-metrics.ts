import { ACTIVE_RUN_STATUSES, MergePolicy, RunStatus, type AgentRun } from '../../../shared/automation/contracts.js';
import { PipelinePolicy } from '../../../shared/automation/pipeline-policy.js';
import type { CheckEvidence, ImprovementMetrics, ImprovementPeriod } from '../../../shared/automation/improvement-metrics.js';
import { TaskStatus } from '../../../shared/tasks/status.js';
import { checkFingerprint, checksMatch } from './check-evidence.js';
import type { AgentRunRepository } from './run-repository.js';

export function collectMetrics(runs: AgentRunRepository, period: ImprovementPeriod, asOf: string): ImprovementMetrics {
  const cohort = runs.cohort(period);
  const taskIds = new Set(cohort.map(run => run.taskId));
  const metrics: ImprovementMetrics = { period, asOf, runs: cohort.length, tasks: taskIds.size,
    technical: { numerator: 0, denominator: 0 }, acceptance: { numerator: 0, denominator: taskIds.size },
    active: 0, stopped: 0, noRequiredChecks: 0, unknown: 0, awaitingAcceptance: 0, acceptedFirstAttempt: 0, occurrences: [] };
  for (const run of cohort) {
    const occurrences = runs.occurrences(run.id);
    metrics.occurrences.push(...occurrences);
    if (ACTIVE_RUN_STATUSES.includes(run.status)) { metrics.active++; continue; }
    if (run.status === RunStatus.Cancelled && (run.userCancelledAt || !run.proposedFix)) { metrics.stopped++; continue; }
    const stages = run.settings.pipeline.map((_, index) => index).filter(stage => PipelinePolicy.checkAt(run.settings, stage, run.feature));
    const candidateRequired = run.settings.mergePolicy === MergePolicy.Local;
    if (!run.settings.checks.length || (!stages.length && !candidateRequired)) { metrics.noRequiredChecks++; continue; }
    const checks = runs.checks(run.id);
    const candidate = run.integration;
    const stagePassed = stages.every(stage => {
      const verification = run.stageChecks?.find(result => result.stage === stage && result.revision === run.revision && result.sha === run.commitSha);
      return !!verification && verifyRefs(checks, verification.ids, run, 'stage', verification.sha, stage);
    });
    const candidatePassed = !!candidate?.candidateSha && candidate.sourceSha === run.commitSha
      && candidate.checkFingerprint === checkFingerprint(run.settings.checks)
      && verifyRefs(checks, candidate.checkIds, run, 'candidate', candidate.candidateSha, undefined, candidate.attempt);
    const terminalSuccess = run.status === RunStatus.Review || run.status === RunStatus.Merged;
    if (terminalSuccess && stagePassed && (!candidateRequired || candidatePassed)) {
      metrics.technical.numerator++; metrics.technical.denominator++;
    } else if (run.status !== RunStatus.Interrupted && (occurrences.some(item => item.technicalRejection && item.revision === run.revision)
      || checks.some(check => check.revision === run.revision && check.fingerprint === checkFingerprint(run.settings.checks)
        && (check.phase === 'stage' ? check.sha === run.commitSha : check.sha === candidate?.candidateSha && check.attempt === candidate.attempt)
        && (check.outcome.kind === 'launch_error' || (check.outcome.kind === 'exit' && check.outcome.code !== 0))))) {
      metrics.technical.denominator++;
    } else metrics.unknown++;
  }
  for (const taskId of taskIds) {
    const task = runs.db.prepare('SELECT status FROM tasks WHERE id = ?').get<{ status: string }>([taskId]);
    const accepted = task?.status === TaskStatus.Done ? runs.acceptedByUser(taskId) : undefined;
    const history = runs.taskHistory(taskId);
    if (accepted) {
      metrics.acceptance.numerator++;
      const started = history.filter(run => run.startedAt && run.startedAt <= accepted.at);
      if (started.length === 1 && readyForUser(started[0]) && started[0].revision === 0
        && !runs.occurrences(started[0].id).some(item => item.at <= accepted.at)
        && !runs.checks(started[0].id).some(check => check.at <= accepted.at
          && (check.outcome.kind === 'launch_error' || (check.outcome.kind === 'exit' && check.outcome.code !== 0)))) {
        metrics.acceptedFirstAttempt++;
      }
    } else if (task?.status === TaskStatus.Review && history.some(readyForUser)) metrics.awaitingAcceptance++;
  }
  metrics.occurrences.sort((a, b) => b.at.localeCompare(a.at) || b.eventId - a.eventId);
  return metrics;
}

function readyForUser(run: AgentRun): boolean { return run.status === RunStatus.Review || run.status === RunStatus.Merged; }

export function verifyRefs(checks: CheckEvidence[], ids: string[] | undefined, run: AgentRun,
  phase: CheckEvidence['phase'], sha: string, stage?: number, attempt?: number): boolean {
  if (!ids) return false;
  const byId = new Map(checks.map(check => [check.id, check]));
  const results = ids.map(id => byId.get(id)).filter((item): item is CheckEvidence => !!item);
  return results.length === ids.length && results.every(check => (stage === undefined || check.stage === stage)
    && (attempt === undefined || check.attempt === attempt))
    && checksMatch(results, run.settings.checks, { runId: run.id, phase, revision: run.revision, sha });
}
