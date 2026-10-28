import { TaskStatus } from '../tasks/status.js';
import { AgentRole, AUTOMATION_START_TASK_STATUSES, type AutomationSettings } from './contracts.js';
import { PipelinePolicy } from './pipeline-policy.js';

export const TASK_STATUS_TITLES: Readonly<Record<TaskStatus, string>> = {
  [TaskStatus.Backlog]: 'Бэклог', [TaskStatus.Planning]: 'Планирование', [TaskStatus.Questions]: 'Вопросы',
  [TaskStatus.Ready]: 'Готово к работе', [TaskStatus.InProgress]: 'В работе', [TaskStatus.Testing]: 'Тестирование',
  [TaskStatus.Review]: 'Ревью', [TaskStatus.Done]: 'Готово',
};
export interface TaskReadinessInput { status: TaskStatus; hasPlan: boolean; openQuestionsCount: number; }
export interface TaskLaunchCandidate extends TaskReadinessInput { id: string; title: string; }
export const TASK_SELECTION_LIMIT = 1000;
export interface TaskReadiness { dorReady: boolean; canStart: boolean; needsAnalysis: boolean; reasons: string[]; dorReasons: string[]; summary: string; }
/** Structural DoR, not a substitute for a human assessment of the plan's quality. */
export class TaskAutomationReadiness {
  public static evaluate(task: TaskReadinessInput, settings: AutomationSettings, active: boolean): TaskReadiness {
    const reasons: string[] = []; const dorReasons: string[] = [];
    const firstAgent = settings.agents.find((agent) => agent.id === settings.pipeline[0]);
    const needsAnalysis = !task.hasPlan && firstAgent?.role === AgentRole.Analyst;
    if (task.status !== TaskStatus.Ready) dorReasons.push('Статус ещё не «Готово к работе».');
    if (!task.hasPlan) dorReasons.push('Нет плана.');
    if (task.openQuestionsCount) { const message = `Есть открытые вопросы: ${task.openQuestionsCount}.`; reasons.push(message); dorReasons.push(message); }
    if (!AUTOMATION_START_TASK_STATUSES.includes(task.status)) reasons.push('Для нового запуска нужен статус backlog, planning или ready. Для текущей работы используйте продолжение запуска.');
    if (active) reasons.push('У задачи уже есть активный запуск.');
    if (PipelinePolicy.needsPlan(settings, task.hasPlan)) reasons.push('Нет плана: добавьте аналитика перед реализацией.');
    const dorReady = dorReasons.length === 0;
    return { dorReady, canStart: reasons.length === 0, needsAnalysis, reasons, dorReasons,
      summary: reasons.length ? 'Запуск заблокирован' : dorReady ? 'DoR: готова' : needsAnalysis ? 'Сначала анализ (не DoR)' : 'Запуск до DoR' };
  }
}
