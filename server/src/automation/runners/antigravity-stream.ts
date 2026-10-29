import { TokenMeter, UsageSource, type TokenUsage } from '../../../../shared/automation/token-usage.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';
import { StageNotes } from '../../../../shared/automation/stage-note.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Decode metadata only; model text, tool outputs and argument bodies stay out of the journal. */
export class AntigravityStream {
  public result?: string;
  public usage?: TokenUsage;
  private readonly steps = new Map<number, TokenUsage>();
  private readonly seen = new Set<string>();
  private readonly tools = new Set<number>();
  public conversationId?: string;
  public constructor(private readonly progress: (line: string) => void,
    private readonly publish?: (usage: TokenUsage, state: { terminal: boolean }) => void,
    private readonly session?: (id: string) => void, private readonly tool?: (count: number) => void,
    private readonly baseline?: TokenUsage) {}
  public record(value: unknown): void {
    const event = object(value);
    const candidate = event.conversation_id ?? object(event.result).conversation_id;
    if (candidate !== undefined && candidate !== this.conversationId) {
      try { this.conversationId = StageNotes.session(candidate); this.session?.(this.conversationId); }
      catch { this.progress('Antigravity: некорректный ID conversation; продолжение недоступно.\n'); }
    }
    if (event.event === 'init') {
      const init = object(event.init);
      const mode = typeof init.permission_mode === 'string' ? init.permission_mode.replace(/[^a-z-]/g, '').slice(0, 40) : 'unknown';
      this.progress('Antigravity stream: permission_mode=' + mode + '.\n');
    }
    if (event.event === 'result') {
      const result = object(event.result); this.result = JSON.stringify(result);
      const usage = this.delta(this.parse(result.usage));
      if (usage) { this.usage = usage; this.publish?.(usage, { terminal: true }); }
      else if (this.usage) { this.usage = { ...this.usage, missingRequests: this.usage.missingRequests + 1 }; this.publish?.(this.usage, { terminal: true }); }
      return;
    }
    if (event.event !== 'step_update') return;
    const step = object(event.step_update);
    if (!Number.isSafeInteger(step.step_index) || !['ACTIVE', 'DONE'].includes(String(step.state))) return;
    if (step.step_type === 'tool') {
      if (!this.tools.has(step.step_index as number)) {
        this.tools.add(step.step_index as number);
        this.tool?.(this.tools.size);
      }
      const key = step.step_index + ':' + step.state;
      if (!this.seen.has(key)) {
        this.seen.add(key);
        const info = object(step.tool_info); const parameters = object(info.parameters);
        const name = String(step.tool_name ?? info.name ?? 'tool').replace(/[^a-zA-Z0-9_./-]/g, '').slice(0, 100);
        const command = typeof parameters.CommandLine === 'string' ? ': ' + CompactProgress.command(parameters.CommandLine) : '';
        this.progress('Antigravity tool ' + name + ': ' + (step.state === 'ACTIVE' ? 'вызов' : info.error ? 'ошибка' : 'завершён') + command + '.\n');
      }
    }
    if (step.state === 'DONE') {
      const usage = this.parse(step.usage);
      if (usage) {
        this.steps.set(step.step_index as number, usage);
        this.usage = [...this.steps.values()].reduce<TokenUsage | undefined>((sum, item) => TokenMeter.add(sum, item), undefined);
        if (this.usage) this.publish?.(this.usage, { terminal: false });
      }
    }
  }
  private parse(value: unknown): TokenUsage | undefined {
    const data = object(value);
    // CLI input_tokens excludes cache reads (the second cached turn can have input=278, cache=30214).
    const usage = { inputTokens: typeof data.input_tokens === 'number' ? data.input_tokens + (typeof data.cache_read_tokens === 'number' ? data.cache_read_tokens : 0) : undefined,
      outputTokens: data.output_tokens, cachedInputTokens: data.cache_read_tokens,
      reasoningTokens: data.thinking_tokens, reportedRequests: 1, missingRequests: 0, source: UsageSource.Antigravity };
    return TokenMeter.valid(usage) ? usage : undefined;
  }
  private delta(total: TokenUsage | undefined): TokenUsage | undefined {
    if (!total || !this.baseline) return total;
    // Terminal counters cover the entire conversation. Partial step events cover this invocation only.
    const usage = { ...total, inputTokens: total.inputTokens - this.baseline.inputTokens,
      outputTokens: total.outputTokens - this.baseline.outputTokens,
      cachedInputTokens: total.cachedInputTokens === undefined || this.baseline.cachedInputTokens === undefined ? undefined : total.cachedInputTokens - this.baseline.cachedInputTokens,
      reasoningTokens: total.reasoningTokens === undefined || this.baseline.reasoningTokens === undefined ? undefined : total.reasoningTokens - this.baseline.reasoningTokens };
    if (TokenMeter.valid(usage)) return usage;
    this.progress('Antigravity: итоговые счётчики меньше сохранённой базы conversation; usage остаётся частичным.\n');
    return undefined;
  }
}
