export interface StageNote {
  summary: string;
  findings?: string[];
  completedSteps?: string[];
  nextStep?: string;
  files?: string[];
  checks?: string[];
}
export interface StageMemory {
  key: string;
  taskId: string;
  stage: number;
  revision: number;
  updatedAt: string;
  conversationId?: string;
  note?: StageNote;
}
export const STAGE_NOTE_LIMITS = { fileBytes: 16384, textChars: 3000, pollMs: 1000, toolsBetweenNotes: 5 } as const;

/** Prose evidence only: the repository remains the source of current code. */
export class StageNotes {
  public static parse(value: unknown): StageNote {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Checkpoint must be a prose object.');
    const note = value as Record<string, unknown>;
    const allowed = ['summary', 'findings', 'completedSteps', 'nextStep', 'files', 'checks'];
    if (Object.keys(note).some(key => !allowed.includes(key)) || JSON.stringify(note).length > STAGE_NOTE_LIMITS.textChars) throw new Error('Checkpoint has unknown fields or exceeds 3000 characters.');
    const prose = (text: unknown, max: number): string => {
      if (typeof text !== 'string' || !text.trim() || text.length > max || /[\r\n\x00-\x1f{}]|```|~~~|=>|\w+\([^)]*\);|^(?:import |export |const |let |class |function |diff --git|@@)/.test(text)) throw new Error('Checkpoint accepts short prose only; code, patches and command output are forbidden.');
      return text.trim();
    };
    const result: StageNote = { summary: prose(note.summary, 600) };
    if (note.nextStep !== undefined) result.nextStep = prose(note.nextStep, 300);
    for (const key of ['findings', 'completedSteps', 'files', 'checks'] as const) {
      if (note[key] === undefined) continue;
      if (!Array.isArray(note[key]) || note[key].length > 6) throw new Error('Checkpoint lists accept at most six items.');
      result[key] = note[key].map(item => prose(item, 220));
    }
    return result;
  }
  public static session(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid native conversation ID.');
    return value;
  }
  public static format(note: StageNote): string {
    const lines = [note.summary];
    for (const [field, label] of [['findings', 'Выводы'], ['completedSteps', 'Выполнено'], ['files', 'Файлы/символы'], ['checks', 'Проверки']] as const)
      if (note[field]?.length) lines.push(`${label}: ${note[field]!.join(' · ')}`);
    lines.push(note.nextStep ? `Следующий шаг: ${note.nextStep}` : 'Следующий шаг не указан: сверьте оставшуюся работу с текущим планом.', 'Промежуточная запись агента, не завершение этапа. Проверяйте актуальный код в worktree.');
    return lines.join('\n');
  }
}
