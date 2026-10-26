import type { RunEvent } from './contracts.js';

export type ConsoleLevel = 'info' | 'command' | 'success' | 'warning' | 'error';
export interface ConsoleLine { id: string; at: string; stage: string; level: ConsoleLevel; text: string; }
export const CONSOLE_LIMITS = { lines: 600, lineChars: 8000, pendingChars: 512 * 1024 } as const;
export interface ConsoleView { lines: ConsoleLine[]; omitted: number; incomplete: boolean; }
type RecordValue = Record<string, unknown>;
type OutputField = 'output' | 'text' | 'stderr';
interface ItemState { command?: string; output?: string; text?: string; stderr?: string; done?: boolean; tails?: Partial<Record<OutputField, ConsoleLine>>; }
const record = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {};

/** Replays a bounded event window deterministically; no transport JSON enters the readable console. */
export class RunConsoleDecoder {
  private lines: ConsoleLine[] = [];
  private omitted = 0;
  private buffer = '';
  private origin?: RunEvent;
  private stage = 'Подготовка';
  private sequence = 0;
  private readonly items = new Map<string, ItemState>();

  public static render(events: readonly RunEvent[]): ConsoleView {
    const decoder = new RunConsoleDecoder(); const seen = new Set<number>();
    const ordered = [...events].sort((a, b) => a.id - b.id);
    if (ordered[0] && !['queued', 'stage'].includes(ordered[0].kind)) decoder.stage = 'Этап вне окна';
    for (const event of ordered) {
      if (seen.has(event.id)) continue; seen.add(event.id); decoder.consume(event);
    }
    if (decoder.buffer && !decoder.buffer.trimStart().startsWith('{')) decoder.emit(decoder.origin!, decoder.buffer);
    return { lines: decoder.lines, omitted: decoder.omitted, incomplete: !!decoder.buffer.trimStart().startsWith('{') };
  }

  public static clean(text: string): string {
    return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }

  private consume(event: RunEvent): void {
    if (event.kind !== 'progress') {
      if (this.buffer) {
        if (!this.buffer.trimStart().startsWith('{')) this.emit(this.origin!, this.buffer);
        else this.emit(event, 'Неполная структурированная запись; исходник доступен отдельно.', 'warning');
        this.buffer = ''; this.origin = undefined;
      }
      if (event.kind === 'stage') { this.stage = event.text.split(':')[0]; this.items.clear(); }
      const level = ['failed', 'error'].includes(event.kind) ? 'error' : ['pass', 'merged'].includes(event.kind) ? 'success'
        : ['questions', 'changes_requested', 'interrupted', 'cancelled'].includes(event.kind) ? 'warning' : 'info';
      for (const line of event.text.split('\n')) {
        const embedded = line.match(/^(.*?:\s*)(\{"type":.*\})$/);
        if (line.trimStart().startsWith('{')) this.decode(event, line);
        else if (embedded) { this.emit(event, embedded[1], level); this.decode(event, embedded[2]); }
        else this.emit(event, line, level);
      }
      return;
    }
    this.origin ??= event; this.buffer += event.text;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      this.decode(this.origin, line); this.origin = this.buffer ? event : undefined;
    }
    if (this.buffer.trimStart().startsWith('{')) {
      try { const value: unknown = JSON.parse(this.buffer); this.structured(this.origin ?? event, record(value)); this.buffer = ''; this.origin = undefined; }
      catch { /* JSONL may be split across progress events. */ }
    }
    if (this.buffer.length > CONSOLE_LIMITS.pendingChars) {
      this.buffer = ''; this.origin = undefined;
      this.emit(event, 'Слишком длинная незавершённая запись пропущена; скачайте исходный журнал.', 'warning');
    }
  }

  private decode(event: RunEvent | undefined, line: string): void {
    if (!event || !line.trim()) return;
    if (line.trimStart().startsWith('{')) {
      try { this.structured(event, record(JSON.parse(line))); }
      catch { this.emit(event, 'Повреждённая структурированная запись; исходник доступен отдельно.', 'warning'); }
    } else this.emit(event, line);
  }

  private structured(event: RunEvent, value: RecordValue): void {
    const type = String(value.type ?? ''); const item = record(value.item);
    if (typeof value.summary === 'string') { this.emit(event, value.summary, value.verdict === 'pass' ? 'success' : 'warning'); return; }
    if (type.startsWith('item.')) {
      const key = String(item.id ?? `${event.id}:${this.sequence}`);
      const prior = this.items.get(key) ?? {}; this.items.set(key, prior);
      if (typeof item.command === 'string' && prior.command !== item.command) { this.emit(event, `$ ${item.command}`, 'command'); prior.command = item.command; }
      if (typeof item.tool === 'string' && !prior.command) { this.emit(event, `MCP: ${item.tool}`, 'command'); prior.command = item.tool; }
      this.delta(event, item.aggregated_output ?? item.stdout, prior, 'output');
      this.delta(event, item.stderr, prior, 'stderr');
      this.delta(event, item.text, prior, 'text');
      const message = record(item.error).message ?? (item.type === 'error' ? item.message : undefined);
      if (typeof message === 'string') this.emit(event, this.errorText(message), 'error');
      if (type === 'item.completed' && typeof item.exit_code === 'number' && !prior.done) {
        this.emit(event, `exit ${item.exit_code}`, item.exit_code === 0 ? 'success' : 'error'); prior.done = true;
      }
      return;
    }
    const error = record(value.error).message ?? (type === 'error' ? value.message : undefined);
    if (typeof error === 'string') { this.emit(event, this.errorText(error), 'error'); return; }
    if (typeof value.stdout === 'string') { this.emit(event, value.stdout); return; }
    if (typeof value.stderr === 'string') { this.emit(event, value.stderr, 'error'); return; }
    if (type === 'turn.completed') { this.emit(event, 'Ответ агента завершён.', 'success'); return; }
    if (['thread.started', 'turn.started', 'thread.closed'].includes(type)) return;
    this.emit(event, `Служебное событие: ${type || 'неизвестный формат'}`);
  }

  private errorText(value: string): string {
    for (let depth = 0; depth < 4; depth++) {
      try {
        const parsed = record(JSON.parse(value)); const message = record(parsed.error).message ?? parsed.message;
        if (typeof message !== 'string' || message === value) break;
        value = message;
      } catch { break; }
    }
    return value;
  }

  private delta(event: RunEvent, value: unknown, prior: ItemState, field: OutputField): void {
    if (typeof value !== 'string') return;
    const old = prior[field] ?? ''; prior[field] = value;
    if (value === old) return;
    const text = value.startsWith(old) ? value.slice(old.length) : value;
    if (field === 'text') {
      if (value.trimStart().startsWith('{')) {
        try {
          const outcome = record(JSON.parse(value));
          if (typeof outcome.summary === 'string') this.structured(event, outcome);
          else this.emit(event, 'Структурированный ответ агента доступен в исходнике.');
        } catch { /* Wait for the rest of a structured agent answer. */ }
        return;
      }
    }
    const severity = field === 'stderr' ? 'error' : undefined;
    const clean = RunConsoleDecoder.clean(text); let remainder = clean;
    const tail = prior.tails?.[field];
    if (tail && value.startsWith(old) && !old.endsWith('\n') && this.lines.includes(tail)) {
      const end = clean.indexOf('\n'); const first = end < 0 ? clean : clean.slice(0, end);
      tail.text = (first.includes('\r') ? first.split('\r').at(-1)! : tail.text + first).slice(0, CONSOLE_LIMITS.lineChars);
      if (end < 0) return;
      remainder = clean.slice(end + 1);
    }
    const last = this.emit(event, remainder, severity);
    prior.tails ??= {};
    prior.tails[field] = !value.endsWith('\n') ? last : undefined;
  }

  private emit(event: RunEvent, value: string, level?: ConsoleLevel): ConsoleLine | undefined {
    let last: ConsoleLine | undefined;
    for (const raw of RunConsoleDecoder.clean(value).split('\n')) {
      const text = raw.replace(/\r$/, '').split('\r').at(-1) ?? ''; if (!text.trim()) continue;
      const severity = level ?? (/\b(error|failed|exception)\b|ошибк/i.test(text) ? 'error' : /\bwarn(?:ing)?\b|предупрежд/i.test(text) ? 'warning' : 'info');
      last = { id: `${event.id}:${this.sequence++}`, at: event.at, stage: this.stage, level: severity,
        text: text.length > CONSOLE_LIMITS.lineChars ? `${text.slice(0, CONSOLE_LIMITS.lineChars)} … [строка сокращена; полный текст в исходнике]` : text };
      this.lines.push(last);
      if (this.lines.length > CONSOLE_LIMITS.lines) { this.lines.shift(); this.omitted++; }
    }
    return last;
  }
}
