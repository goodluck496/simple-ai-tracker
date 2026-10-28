import type { AgentRole, RunnerId } from './contracts.js';

export const UsageSource = { Codex: 'codex-json', Claude: 'claude-json', Antigravity: 'antigravity-json', Compatible: 'chat-completions' } as const;
export type UsageSource = typeof UsageSource[keyof typeof UsageSource];
/** Cache counts are included in input; reasoning is included in output. Never add them again. */
export interface TokenUsage {
  inputTokens: number; outputTokens: number;
  cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningTokens?: number;
  reportedRequests: number; missingRequests: number; source: UsageSource;
}
export interface UsageAttempt {
  kind?: 'pipeline' | 'resolver';
  id: string; stage: number; revision: number; role: AgentRole; runner: RunnerId; model: string;
  startedAt: string; updatedAt: string; finished: boolean; usage?: TokenUsage;
}
export interface UsageSummary {
  inputTokens: number; outputTokens: number; totalTokens: number;
  measuredAttempts: number; attempts: number; partial: boolean;
}
export class TokenMeter {
  public static valid(value: unknown): value is TokenUsage {
    if (!value || typeof value !== 'object') return false;
    const u = value as TokenUsage;
    const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    return Object.values(UsageSource).includes(u.source) && count(u.inputTokens) && count(u.outputTokens)
      && Number.isSafeInteger(u.inputTokens + u.outputTokens) && count(u.reportedRequests) && u.reportedRequests > 0 && count(u.missingRequests)
      && [u.cachedInputTokens, u.cacheWriteInputTokens, u.reasoningTokens].every((n) => n === undefined || count(n))
      && (u.cachedInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0) <= u.inputTokens && (u.reasoningTokens ?? 0) <= u.outputTokens;
  }
  public static add(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
    if (!a) return { ...b };
    const optional = (key: 'cachedInputTokens' | 'cacheWriteInputTokens' | 'reasoningTokens') =>
      a[key] === undefined || b[key] === undefined ? undefined : a[key]! + b[key]!;
    return { ...b, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
      cachedInputTokens: optional('cachedInputTokens'), cacheWriteInputTokens: optional('cacheWriteInputTokens'), reasoningTokens: optional('reasoningTokens'),
      reportedRequests: a.reportedRequests + b.reportedRequests, missingRequests: a.missingRequests + b.missingRequests };
  }
  public static summary(attempts: readonly UsageAttempt[] = [], historyIncomplete = false): UsageSummary {
    const known = attempts.filter((a) => a.usage);
    const inputTokens = known.reduce((sum, a) => sum + a.usage!.inputTokens, 0);
    const outputTokens = known.reduce((sum, a) => sum + a.usage!.outputTokens, 0);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, measuredAttempts: known.length, attempts: attempts.length,
      partial: historyIncomplete || attempts.some((a) => !a.finished || !a.usage || a.usage.missingRequests > 0) };
  }
  public static label(summary: UsageSummary): string {
    if (!summary.measuredAttempts) return 'Токены: нет данных';
    return `Токены: ${summary.totalTokens.toLocaleString('ru-RU')}${summary.partial ? ' · частичные данные' : ''}`;
  }
}
