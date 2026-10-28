import { TokenMeter, UsageSource, type TokenUsage } from '../../../../shared/automation/token-usage.js';
import { CompactProgress } from '../../../../shared/automation/compact-progress.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Decode metadata only; model text, tool outputs and argument bodies stay out of the journal. */
export class AntigravityStream {
  public result?: string;
  public usage?: TokenUsage;
  private readonly steps = new Map<number, TokenUsage>();
  private readonly seen = new Set<string>();
  public constructor(private readonly progress: (line: string) => void,
    private readonly publish?: (usage: TokenUsage, state: { terminal: boolean }) => void) {}
  public record(value: unknown): void {
    const event = object(value);
    if (event.event === 'init') {
      const init = object(event.init);
      const mode = typeof init.permission_mode === 'string' ? init.permission_mode.replace(/[^a-z-]/g, '').slice(0, 40) : 'unknown';
      this.progress('Antigravity stream: permission_mode=' + mode + '.\n');
    }
    if (event.event === 'result') {
      const result = object(event.result); this.result = JSON.stringify(result);
      const usage = this.parse(result.usage);
      if (usage) { this.usage = usage; this.publish?.(usage, { terminal: true }); }
      else if (this.usage) { this.usage = { ...this.usage, missingRequests: this.usage.missingRequests + 1 }; this.publish?.(this.usage, { terminal: true }); }
      return;
    }
    if (event.event !== 'step_update') return;
    const step = object(event.step_update);
    if (!Number.isSafeInteger(step.step_index) || !['ACTIVE', 'DONE'].includes(String(step.state))) return;
    if (step.step_type === 'tool') {
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
    const usage = { inputTokens: data.input_tokens, outputTokens: data.output_tokens, cachedInputTokens: data.cache_read_tokens,
      reasoningTokens: data.thinking_tokens, reportedRequests: 1, missingRequests: 0, source: UsageSource.Antigravity };
    return TokenMeter.valid(usage) ? usage : undefined;
  }
}
