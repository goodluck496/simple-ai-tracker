import { RunnerId } from '../../../../shared/automation/contracts.js';
import { TokenMeter, UsageSource, type TokenUsage } from '../../../../shared/automation/token-usage.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const MAX_USAGE_RECORD_CHARS = 2 * 1024 * 1024;

export class UsageParser {
  public static compatible(value: unknown): TokenUsage | undefined {
    const u = object(value);
    return this.normalized(u.prompt_tokens, u.completion_tokens, UsageSource.Compatible,
      object(u.prompt_tokens_details).cached_tokens ?? u.prompt_cache_hit_tokens,
      undefined, object(u.completion_tokens_details).reasoning_tokens);
  }
  public static native(runner: RunnerId, value: unknown): TokenUsage | undefined {
    const event = object(value); const u = object(event.usage);
    if (runner === RunnerId.Codex && event.type === 'turn.completed') {
      return this.normalized(u.input_tokens, u.output_tokens, UsageSource.Codex, u.cached_input_tokens, u.cache_write_input_tokens, u.reasoning_output_tokens);
    }
    if (runner === RunnerId.ClaudeCode && event.type === 'result') {
      const input = count(u.input_tokens); const read = count(u.cache_read_input_tokens); const write = count(u.cache_creation_input_tokens);
      // Claude reports uncached input separately from cache reads/writes.
      return this.normalized(input === undefined ? undefined : input + (read ?? 0) + (write ?? 0), u.output_tokens, UsageSource.Claude, read, write);
    }
    return undefined;
  }
  private static normalized(input: unknown, output: unknown, source: TokenUsage['source'], cached?: unknown, write?: unknown, reasoning?: unknown): TokenUsage | undefined {
    const usage = { inputTokens: count(input), outputTokens: count(output), cachedInputTokens: count(cached), cacheWriteInputTokens: count(write),
      reasoningTokens: count(reasoning), reportedRequests: 1, missingRequests: 0, source };
    return TokenMeter.valid(usage) ? usage : undefined;
  }
}

/** Reads complete stdout records before the executor truncates its log tail. Never parses stderr. */
export class NativeUsageStream {
  private buffer = '';
  private skipping = false;
  private missed = 0;
  public usage?: TokenUsage;
  public constructor(private readonly runner: RunnerId, private readonly publish?: (usage: TokenUsage) => void,
    private readonly record?: (value: unknown) => void) {}
  public push(chunk: string): void {
    for (const [index, part] of chunk.split('\n').entries()) {
      if (index) { this.line(); this.skipping = false; }
      if (this.skipping) continue;
      if (this.buffer.length + part.length > MAX_USAGE_RECORD_CHARS) { this.buffer = ''; this.skipping = true; this.missing(); continue; }
      this.buffer += part;
    }
  }
  public finish(): void { this.line(); }
  private line(): void {
    const text = this.buffer.trim(); this.buffer = '';
    if (!text) return;
    try {
      const value: unknown = JSON.parse(text);
      this.record?.(value);
      const parsed = UsageParser.native(this.runner, value);
      if (!parsed) {
        const type = object(value).type;
        if ((this.runner === RunnerId.Codex && type === 'turn.completed') || (this.runner === RunnerId.ClaudeCode && type === 'result')) this.missing();
        return;
      }
      this.usage = TokenMeter.add(this.usage, { ...parsed, missingRequests: this.missed });
      this.missed = 0;
      this.publish?.(this.usage);
    } catch { /* Non-JSON output is not token evidence. */ }
  }
  private missing(): void {
    if (!this.usage) { this.missed++; return; }
    this.usage = { ...this.usage, missingRequests: this.usage.missingRequests + 1 };
    this.publish?.(this.usage);
  }
}
