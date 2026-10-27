import type { AgentRun } from './contracts.js';
import { TokenMeter } from './token-usage.js';

/** Limits count observed cumulative input, including cached input exactly once. */
export class RunBudget {
  public static limits(run: AgentRun) {
    return { calls: run.settings.maxAgentCalls ?? 6, input: run.settings.maxInputTokens ?? 500000,
      minutes: run.settings.maxRunMinutes ?? 20 };
  }
  public static elapsed(run: AgentRun, now: number): number {
    return (run.budgetElapsedMs ?? 0) + ((run.status === 'running' || run.status === 'integrating') && run.budgetUpdatedAt
      ? Math.max(0, now - Date.parse(run.budgetUpdatedAt)) : 0);
  }
  public static reason(run: AgentRun, now: number, beforeCall = false): string | undefined {
    const limits = this.limits(run);
    if (this.elapsed(run, now) >= limits.minutes * 60000) return `Run budget exhausted: active time limit ${limits.minutes} min.`;
    if (TokenMeter.summary(run.usageAttempts).inputTokens >= limits.input) return `Run budget exhausted: input token limit ${limits.input} (cached included).`;
    if (beforeCall && (run.usageAttempts?.length ?? 0) >= limits.calls) return `Run budget exhausted: agent call limit ${limits.calls}.`;
    return undefined;
  }
}
