/** Validate structure and explicit purpose; factual accuracy still requires review. */
export class CommitMessage {
  public static readonly maxLength = 240;
  /** The worker already knows the accepted task purpose; do not recall an agent just for a missing connective. */
  public static forTask(value: unknown, taskId: string, title: string): string {
    try { return this.validate(value, taskId); }
    catch {
      if (typeof value !== 'string') return this.fallback(taskId, title);
      const prefix = `[#${taskId}] - `;
      if (!value.startsWith(prefix) || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)
        || (value.slice(prefix.length).match(/[А-Яа-яЁё]{2,}/g) ?? []).length < 3)
        return this.fallback(taskId, title);
      const purpose = title.replace(/\s+/g, ' ').trim();
      if (!purpose) return this.fallback(taskId, title);
      try {
        return this.validate(`${value}, чтобы выполнить требование задачи «${purpose}»`, taskId);
      } catch {
        return this.fallback(taskId, title);
      }
    }
  }
  public static fallback(taskId: string, title: string): string {
    const cleanTitle = (title || 'выполнить требования').replace(/[\r\n\x00-\x1f{}]|```|~~~/g, ' ').replace(/\s+/g, ' ').trim();
    const purpose = cleanTitle.length > 80 ? cleanTitle.slice(0, 77) + '...' : cleanTitle;
    return `[#${taskId}] - Реализованы изменения по плану, чтобы выполнить задачу «${purpose}»`;
  }
  public static validate(value: unknown, taskId: string): string {
    const prefix = `[#${taskId}] - `;
    const fail = (): never => { throw new Error(`Commit message rejected. Required: ${prefix}описание на русском, что сделано и для чего. Include an explicit purpose (для/чтобы/ради). Saved work and checkpoint are retained; no automatic model retry.`); };
    if (typeof value !== 'string' || value.length > this.maxLength || /[\x00-\x1f\x7f]/.test(value)
      || value !== value.trim() || !value.startsWith(prefix)) return fail();
    const description = value.slice(prefix.length);
    if ((description.match(/[А-Яа-яЁё]{2,}/g) ?? []).length < 3) return fail();
    const purpose = description.match(/(?:^|[\s,;])(?:для|чтобы|ради)\s+(.+)$/i)?.[1];
    if (!purpose || !/[А-Яа-яЁё]{2,}/.test(purpose)) return fail();
    return value;
  }
}
