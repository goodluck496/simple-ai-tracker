import { TaskStatus } from '../../../shared/tasks/status.js';
import type { ImprovementOccurrence } from '../../../shared/automation/improvement-metrics.js';
import type { TaskService } from '../services/task-service.js';
import type { AgentRunRepository } from './run-repository.js';

const FEATURE_ID = 'SAT-55';
const SECTION_START = '<!-- automation-improvement:start -->';
const SECTION_END = '<!-- automation-improvement:end -->';

interface OccurrenceInput extends Omit<ImprovementOccurrence, 'id' | 'reviewState' | 'improvementTaskId' | 'confirmedCause'> {
  cause?: { key: string; description: string };
}

export class ImprovementService {
  public constructor(private readonly runs: AgentRunRepository, private readonly tasks: TaskService, private readonly workspace: string) {}

  public recordOccurrence(input: OccurrenceInput): ImprovementOccurrence {
    return this.runs.db.transaction(() => {
      const existing = this.runs.occurrence(input.runId, input.eventId);
      if (existing) return existing;
      const { cause, ...source } = input;
      const occurrence: ImprovementOccurrence = { ...source, id: `${input.runId}:${input.eventId}`,
        confirmedCause: cause?.description, reviewState: 'new' };
      const key = cause ? `cause:${cause.key}` : `event:${occurrence.id}`;
      if (this.workspace === 'simple-ai-tracker' && this.canCreateCard(input.taskId)) this.updateCard(occurrence, key);
      this.runs.db.prepare(`INSERT INTO automation_occurrences(event_id, run_id, task_id, at, cause_key, improvement_task_id, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run([input.eventId, input.runId, input.taskId, input.at, cause?.key ?? null,
        occurrence.improvementTaskId ?? null, JSON.stringify(occurrence)]);
      return occurrence;
    });
  }

  public recommend(occurrence: ImprovementOccurrence, recommendation: string): void {
    this.runs.db.prepare('UPDATE automation_occurrences SET payload = ? WHERE run_id = ? AND event_id = ?')
      .run([JSON.stringify({ ...occurrence, recommendation: recommendation.slice(0, 1000) }), occurrence.runId, occurrence.eventId]);
  }

  private canCreateCard(taskId: string): boolean {
    const task = this.runs.db.prepare('SELECT parent_id FROM tasks WHERE id = ?').get<{ parent_id: string | null }>([taskId]);
    const feature = this.runs.db.prepare('SELECT type FROM tasks WHERE id = ?').get<{ type: string }>([FEATURE_ID]);
    return !!task && taskId !== FEATURE_ID && task.parent_id !== FEATURE_ID && feature?.type === 'feature';
  }

  private updateCard(occurrence: ImprovementOccurrence, key: string): void {
    const link = this.runs.db.prepare(`SELECT c.improvement_task_id AS id FROM automation_improvement_cases c
      JOIN tasks t ON t.id = c.improvement_task_id WHERE c.cause_key = ?`).get<{ id: string }>([key]);
    const card = link ? this.tasks.getTaskCard(link.id) : undefined;
    const evidence = `[Запуск ${occurrence.runId}, событие ${occurrence.eventId}](?workspace=${encodeURIComponent(this.workspace)}&automationRun=${encodeURIComponent(occurrence.runId)}&eventId=${occurrence.eventId})`;
    const body = [
      SECTION_START,
      card?.status === TaskStatus.Done ? 'Сбой повторился после исправления. Предлагается повторное ознакомление.' : 'Предлагается ознакомиться со случаем.',
      evidence,
      `Наблюдение: ${occurrence.fact}`,
      occurrence.confirmedCause ? `Установленная причина: ${occurrence.confirmedCause}` : 'Открытый вопрос: что вызвало этот отказ?',
      `Предлагаемое изменение: ${occurrence.recommendation ?? 'установить причину по журналу и устранить её в месте возникновения'}.`,
      'Проверка: воспроизвести сопоставимый сценарий и сверить результат по событию и исполнению проверки.',
      SECTION_END,
    ].join('\n\n');
    if (card) {
      occurrence.improvementTaskId = card.id;
      occurrence.reviewState = card.status === TaskStatus.Done ? 'repeated_after_done' : 'repeated';
      const start = card.description.indexOf(SECTION_START);
      const end = start < 0 ? -1 : card.description.indexOf(SECTION_END, start + SECTION_START.length);
      const description = end < 0 ? `${card.description}\n\n${body}`
        : card.description.slice(0, start) + body + card.description.slice(end + SECTION_END.length);
      this.tasks.updateTask({ id: card.id, description });
      this.tasks.addComment({ id: card.id, text: `Новое свидетельство отказа. ${evidence}\n\n${occurrence.fact}`, actor: 'agent' });
    } else {
      const created = this.tasks.createTask({ title: `Исследовать сбой автоматизации ${occurrence.taskId}`,
        parentId: FEATURE_ID, status: TaskStatus.Backlog, description: body });
      occurrence.improvementTaskId = created.id;
      this.runs.db.prepare(`INSERT INTO automation_improvement_cases(cause_key, improvement_task_id) VALUES (?, ?)
        ON CONFLICT(cause_key) DO UPDATE SET improvement_task_id = excluded.improvement_task_id`).run([key, created.id]);
    }
  }
}
