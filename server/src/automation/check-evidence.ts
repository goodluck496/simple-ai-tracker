import { createHash } from 'node:crypto';
import type { AgentRun, CheckCommand } from '../../../shared/automation/contracts.js';
import type { CheckExecution } from '../../../shared/automation/improvement-metrics.js';

export const checkFingerprint = (checks: CheckCommand[]): string =>
  createHash('sha256').update(JSON.stringify(checks.map(({ command, args }) => [command, args]))).digest('hex');

export function checksMatch(
  results: CheckExecution[], checks: CheckCommand[], context: Pick<CheckExecution, 'runId' | 'phase' | 'revision' | 'sha'>,
): boolean {
  const fingerprint = checkFingerprint(checks);
  return results.length === checks.length && results.every((result, position) =>
    result.runId === context.runId && result.phase === context.phase && result.revision === context.revision
    && result.sha === context.sha && result.fingerprint === fingerprint && result.position === position
    && result.attempt === results[0].attempt && result.stage === results[0].stage
    && result.outcome.kind === 'exit' && result.outcome.code === 0);
}

export function checkBelongsToRun(check: CheckExecution, run: AgentRun): boolean {
  const configured = run.settings.checks[check.position];
  return check.runId === run.id && check.revision === run.revision && check.stage === run.stage
    && check.fingerprint === checkFingerprint(run.settings.checks)
    && configured?.command === check.command && JSON.stringify(configured.args) === JSON.stringify(check.args);
}
