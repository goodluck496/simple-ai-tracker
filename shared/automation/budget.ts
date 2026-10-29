import type { AgentRun } from './contracts.js';
import { TokenMeter } from './token-usage.js';

/** Limits count observed cumulative input, including cached input exactly once. */
export class RunBudget {
  public static time(run: AgentRun, now: number) {
    const limitMs = this.limits(run).minutes * 60000;
    const usedMs = this.elapsed(run, now);
    return { usedMs, limitMs, remainingMs: Math.max(0, limitMs - usedMs) };
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
    return { input: total.inputTokens, cached, nonCached, limit, percent: Math.floor(total.inputTokens * 100 / limit),
      partial: total.partial, measured: total.measuredAttempts,
      advice: total.inputTokens >= limit
        ? 'Лимит накопленного входа достигнут. Сначала проверьте повторные чтения и шаг плана, сохраните результат. Увеличивайте лимит только для измеренной оставшейся работы; продолжение сохраняет уже потраченный бюджет.'
        : 'Лимит считает суммарный вход всех обращений, включая кеш. Это не размер одного окна контекста и не денежная стоимость. Рост кеша не означает столько же нового текста.' };
  }
  public static limits(run: AgentRun) {
    return { calls: run.settings.maxAgentCalls ?? 6, input: run.settings.maxInputTokens ?? 500000,
      minutes: run.settings.maxRunMinutes ?? 20 };
  }
  public static elapsed(run: AgentRun, now: number): number {
    return (run.budgetElapsedMs ?? 0) + ((run.status === 'running' || run.status === 'integrating') && run.phase !== 'waiting-slot' && run.budgetUpdatedAt
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
