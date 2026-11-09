import type { AgentRun } from './contracts.js';
import { TokenMeter, type TokenUsage, type UsageAttempt } from './token-usage.js';

/** Limits exclude reported cache reads. Cache writes still consume budget. */
export class RunBudget {
  public static chargeableInput(usage?: TokenUsage): number {
    return usage ? Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0)) : 0;
  }
  public static usedInput(attempts: readonly UsageAttempt[] = []): number {
    return attempts.reduce((sum, attempt) => sum + this.chargeableInput(attempt.usage), 0);
  }
  public static time(run: AgentRun, now: number) {
    const limitMs = this.limits(run).minutes * 60000;
    const usedMs = this.elapsed(run, now);
    return { disabled: run.trustedExecution === true, usedMs, limitMs, remainingMs: Math.max(0, limitMs - usedMs) };
  }
  public static stopReason(run: AgentRun): string {
    const summary = run.summary ?? '';
    if (/execution time budget exhausted|active time limit|time budget exhausted/i.test(summary)) return 'Исчерпан общий лимит времени запуска. Уже потраченное время сохраняется при продолжении.';
    if (/input token limit|input.*budget exhausted/i.test(summary)) return 'Исчерпан лимит суммарных входных токенов запуска.';
    if (/agent call limit/i.test(summary)) return 'Исчерпан лимит вызовов агентов.';
    return summary;
  }
  public static explain(run: AgentRun) {
    const observed = (run.usageAttempts ?? []).filter(attempt => attempt.usage);
    const total = TokenMeter.summary(run.usageAttempts, run.usageIncomplete);
    const cacheKnown = observed.length > 0 && observed.every(attempt => attempt.usage!.cachedInputTokens !== undefined);
    const cached = cacheKnown ? observed.reduce((sum, attempt) => sum + attempt.usage!.cachedInputTokens!, 0) : undefined;
    const nonCached = cached === undefined ? undefined : total.inputTokens - cached;
    const limit = this.limits(run).input;
    const input = this.usedInput(run.usageAttempts);
    return { disabled: run.trustedExecution === true, input, totalInput: total.inputTokens, cached, nonCached, limit, percent: Math.floor(input * 100 / limit),
      partial: total.partial, measured: total.measuredAttempts,
      advice: run.trustedExecution ? 'Доверенный запуск: квоты отключены. Токены продолжают учитываться, автоматического денежного потолка нет.' : input >= limit
        ? 'Лимит накопленного входа достигнут. Сначала проверьте повторные чтения и шаг плана, сохраните результат. Увеличивайте лимит только для измеренной оставшейся работы; продолжение сохраняет уже потраченный бюджет.'
        : 'Из бюджета вычитается подтверждённое чтение кеша. Вход с неизвестным объёмом чтения кеша учитывается полностью.' };
  }
  public static limits(run: AgentRun) {
    return { calls: run.settings.maxAgentCalls ?? 6, input: run.settings.maxInputTokens ?? 500000,
      minutes: run.settings.maxRunMinutes ?? 20 };
  }
  public static elapsed(run: AgentRun, now: number): number {
    return (run.budgetElapsedMs ?? 0) + ((run.status === 'running' || run.status === 'integrating') && run.phase === 'agent' && run.budgetUpdatedAt
      ? Math.max(0, now - Date.parse(run.budgetUpdatedAt)) : 0);
  }
  public static reason(run: AgentRun, now: number, beforeCall = false): string | undefined {
    if (run.trustedExecution) return undefined;
    const limits = this.limits(run);
    if (this.elapsed(run, now) >= limits.minutes * 60000) return `Run budget exhausted: active time limit ${limits.minutes} min.`;
    if (this.usedInput(run.usageAttempts) >= limits.input) return `Run budget exhausted: input token limit ${limits.input} (reported cache reads excluded).`;
    if (beforeCall && (run.usageAttempts?.length ?? 0) >= limits.calls) return `Run budget exhausted: agent call limit ${limits.calls}.`;
    return undefined;
  }
}
