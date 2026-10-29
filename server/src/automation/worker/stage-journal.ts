import fs from 'node:fs/promises';
import path from 'node:path';
import { StageNotes, STAGE_NOTE_LIMITS, type StageMemory, type StageNote } from '../../../../shared/automation/stage-note.js';
import { RunWorkspace } from './run-workspace.js';

export interface CheckpointUpdate { key: string; note?: StageNote; conversationId?: string; }

/** Runtime mailbox only. Durable task notes and native sessions are written through tracker MCP. */
export class StageJournal {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private busy?: Promise<void>;
  private seen = '';
  private rejected = '';
  private failure?: unknown;
  private conversationId?: string;
  private note?: StageNote;
  private readonly file: string;
  public constructor(private readonly cwd: string, public readonly key: string,
    private readonly publish: (value: CheckpointUpdate) => Promise<unknown>,
    private readonly progress: (text: string) => void, private readonly onError: () => void) {
    this.file = path.join(cwd, '.sat', 'stage-note.json');
  }
  public async start(memory?: StageMemory): Promise<void> {
    this.conversationId = memory?.key === this.key ? memory.conversationId : undefined;
    // Recover mail written just before a hard worker crash, before starting another model.
    await this.flush();
    if (this.failure) throw this.failure;
    await RunWorkspace.atomic(path.join(this.cwd, '.sat', 'stage-context.json'), { key: this.key,
      noteFile: '.sat/stage-note.json', noteSchema: { summary: 'short prose', implementationPlan: ['exact file/symbol, change, focused check; required before source edits when no plan exists'], findings: ['confirmed fact'], completedSteps: ['S1'], nextStep: 'one concrete action', files: ['path#symbol'], checks: ['command: exit/count/result'] },
      currentNote: this.note ?? (memory?.key === this.key ? memory.note : undefined) });
    this.timer = setInterval(() => { void this.flush().catch(error => { this.failure = error; this.onError(); }); }, STAGE_NOTE_LIMITS.pollMs);
  }
  public session(id: string): void {
    if (this.conversationId === id) return;
    this.conversationId = StageNotes.session(id);
    this.enqueue({ key: this.key, conversationId: this.conversationId });
  }
  public async checkpoint(value: unknown): Promise<void> {
    const note = StageNotes.parse(value);
    this.note = note;
    this.enqueue({ key: this.key, note });
    await this.pending;
    if (this.failure) throw this.failure;
  }
  private enqueue(value: CheckpointUpdate): void {
    this.pending = this.pending.then(async () => { if (!this.failure) await this.publish(value); }).catch(error => {
      this.failure = error; this.onError();
    });
  }
  public async flush(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.read().finally(() => { this.busy = undefined; });
    return this.busy;
  }
  private async read(): Promise<void> {
    let text: string;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STAGE_NOTE_LIMITS.fileBytes) throw new Error('Checkpoint mailbox must be a small regular file.');
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.reject('file'); return;
    }
    if (text === this.seen || text === this.rejected) return;
    try {
      const value = JSON.parse(text) as { key?: unknown; note?: unknown };
      if (value && typeof value.key === 'string' && /^[a-f0-9]{64}$/.test(value.key) && value.key !== this.key) { this.seen = text; return; }
      if (!value || value.key !== this.key || Object.keys(value).some(key => !['key', 'note'].includes(key))) throw new Error('Wrong checkpoint context.');
      const note = StageNotes.parse(value.note);
      this.note = note;
      this.seen = text;
      this.enqueue({ key: this.key, note });
      await this.pending;
    } catch (error) { this.reject(text, error instanceof SyntaxError ? 'некорректный JSON' : error instanceof Error ? error.message : 'неверный формат'); }
  }
  private reject(value: string, reason = 'нужен небольшой обычный файл'): void {
    if (this.rejected === value) return;
    this.rejected = value;
    this.progress('Checkpoint отклонён: ' + reason + '. Содержимое не опубликовано.\n');
  }
  public async close(): Promise<void> {
    clearInterval(this.timer);
    if (this.busy) await this.busy;
    await this.flush();
    await this.pending;
    if (this.failure) throw this.failure;
  }
}
