/** Bound a stalled transport backlog without keeping an unparseable tail of a JSONL record. */
export class ProgressBuffer {
  private text = '';
  private dropped = 0;
  private discardUntilNewline = false;
  public constructor(private readonly limit = 2 * 1024 * 1024) {}
  public get length(): number { return this.text.length + this.dropped; }
  public append(value: string): void {
    if (this.discardUntilNewline) {
      const end = value.indexOf('\n');
      if (end < 0) { this.dropped += value.length; return; }
      this.dropped += end + 1; value = value.slice(end + 1); this.discardUntilNewline = false;
    }
    this.text += value;
    if (this.text.length <= this.limit) return;
    const end = this.text.indexOf('\n', this.text.length - this.limit);
    if (end >= 0) { this.dropped += end + 1; this.text = this.text.slice(end + 1); }
    else { this.dropped += this.text.length; this.text = ''; this.discardUntilNewline = true; }
  }
  public take(): string {
    const output = (this.dropped ? `\n[Журнал ограничен: пропущено ${this.dropped} символов вывода до сохранения.]\n` : '') + this.text;
    this.text = ''; this.dropped = 0; return output;
  }
}
