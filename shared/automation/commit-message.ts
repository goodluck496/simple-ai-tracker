/** Validate structure and explicit purpose; factual accuracy still requires review. */
export class CommitMessage {
  public static readonly maxLength = 240;
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
