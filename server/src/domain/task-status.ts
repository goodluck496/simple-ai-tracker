import { TrackerError } from '../core/errors.js';

/**
 * Статусы карточки Simple AI Tracker.
 *
 * Жизненный цикл: backlog → planning → questions → ready → in_progress →
 * testing → review → done.
 */
export const TASK_STATUSES = [
  'backlog',
  'planning',
  'questions',
  'ready',
  'in_progress',
  'testing',
  'review',
  'done',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Кто имеет право переводить карточку в статус. */
export type StatusOwner = 'agent' | 'user' | 'both';

export interface StatusMeta {
  readonly status: TaskStatus;
  readonly title: string;
  readonly shortTitle: string;
  readonly description: string;
  readonly icon: string;
  readonly severity: 'secondary' | 'info' | 'warn' | 'success' | 'danger';
  /** Кто может ставить статус: агент, пользователь или оба. */
  readonly owner: StatusOwner;
  /** Подсказка агенту, что делать в этом статусе (попадает в контекст-пак MCP). */
  readonly agentGuidance: string;
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  backlog: {
    status: 'backlog',
    title: 'Бэклог',
    shortTitle: 'Backlog',
    description: 'Задача ожидает проработки агентом.',
    icon: 'pi pi-inbox',
    severity: 'secondary',
    owner: 'both',
    agentGuidance: 'Возьми задачу в planning, собери контекст через tracker_get_task и исследуй код/скилы проекта.',
  },
  planning: {
    status: 'planning',
    title: 'Планирование',
    shortTitle: 'Planning',
    description: 'Агент исследует задачу и готовит план решения.',
    icon: 'pi pi-compass',
    severity: 'info',
    owner: 'agent',
    agentGuidance: 'Исследуй задачу, при необходимости задай вопросы (tracker_ask_questions) и прикрепи план .md через tracker_attach_plan.',
  },
  questions: {
    status: 'questions',
    title: 'Вопросы',
    shortTitle: 'Questions',
    description: 'Агент задал вопросы в карточке и ждёт ответа пользователя.',
    icon: 'pi pi-question-circle',
    severity: 'warn',
    owner: 'agent',
    agentGuidance: 'Работа остановлена: дождись ответов пользователя в карточке. Не продолжай реализацию до ответов.',
  },
  ready: {
    status: 'ready',
    title: 'Готово к работе',
    shortTitle: 'Ready',
    description: 'План согласован, вопросов нет — можно приступать к реализации.',
    icon: 'pi pi-sparkles',
    severity: 'success',
    owner: 'both',
    agentGuidance: 'Открой прикреплённый план (tracker_get_task → plan.current) и переводи задачу в in_progress, реализуя строго по плану.',
  },
  in_progress: {
    status: 'in_progress',
    title: 'В работе',
    shortTitle: 'In Progress',
    description: 'Агент реализует задачу строго по согласованному плану.',
    icon: 'pi pi-cog',
    severity: 'info',
    owner: 'agent',
    agentGuidance: 'Реализуй строго по плану. Новый вопрос → tracker_record_clarification или tracker_ask_questions. После реализации переведи задачу в testing.',
  },
  testing: {
    status: 'testing',
    title: 'Тестирование',
    shortTitle: 'Testing',
    description: 'Агент пишет и прогоняет автотесты, проверяет выполнение задачи.',
    icon: 'pi pi-verified',
    severity: 'warn',
    owner: 'agent',
    agentGuidance: 'Напиши/прогони автотесты, проверь критерии приёмки, приложи отчёт (tracker_add_attachment) и переведи задачу в review.',
  },
  review: {
    status: 'review',
    title: 'Готово к проверке',
    shortTitle: 'Review',
    description: 'Тесты зелёные; карточка ждёт проверки пользователем. В done переводит только пользователь.',
    icon: 'pi pi-eye',
    severity: 'warn',
    owner: 'agent',
    agentGuidance: 'Сообщи пользователю, что карточка готова к проверке. Не переводи в done самостоятельно — это делает только пользователь.',
  },
  done: {
    status: 'done',
    title: 'Готово',
    shortTitle: 'Done',
    description: 'Задача проверена пользователем и закрыта.',
    icon: 'pi pi-check-circle',
    severity: 'success',
    owner: 'both',
    agentGuidance: 'Задача закрыта. Изменения статуса выполнил пользователь.',
  },
};

/** Разрешённые переходы между статусами. */
export const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['planning', 'questions', 'ready', 'in_progress'],
  planning: ['questions', 'ready', 'in_progress', 'backlog'],
  questions: ['planning', 'ready', 'in_progress', 'backlog'],
  ready: ['in_progress', 'planning', 'questions', 'backlog'],
  in_progress: ['testing', 'questions', 'planning', 'ready'],
  testing: ['review', 'in_progress', 'questions', 'planning'],
  review: ['done', 'testing', 'in_progress'],
  done: ['in_progress', 'review'],
};

/** Статусы, которые ставит только пользователь. */
export const USER_ONLY_STATUSES: readonly TaskStatus[] = ['done'];

export type StatusActor = 'agent' | 'user';

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function assertTaskStatus(value: unknown, fieldName = 'status'): TaskStatus {
  if (!isTaskStatus(value)) {
    throw new TrackerError('VALIDATION_FAILED', `Недопустимое значение ${fieldName}: "${String(value)}".`, {
      allowed: TASK_STATUSES,
    });
  }
  return value;
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Проверяет допустимость перехода и права актора.
 *
 * Пользователь — владелец процесса: он может переставить карточку в любой
 * статус (в том числе сразу в done). Ограничения действуют для агента: он идёт
 * строго по регламенту и не закрывает задачи самостоятельно.
 */
export function assertTransition(from: TaskStatus, to: TaskStatus, actor: StatusActor): void {
  if (from === to) return;
  if (actor === 'user') return;
  if (USER_ONLY_STATUSES.includes(to)) {
    throw new TrackerError(
      'STATUS_REQUIRES_USER',
      `Статус "${to}" устанавливает только пользователь. Агент не переводит задачу в "${to}" самостоятельно.`,
      { from, to, actor },
    );
  }
  if (!canTransition(from, to)) {
    throw new TrackerError('INVALID_TRANSITION', `Недопустимый переход статуса: "${from}" → "${to}".`, {
      from,
      to,
      allowed: ALLOWED_TRANSITIONS[from],
    });
  }
}

export function statusOrder(status: TaskStatus): number {
  return TASK_STATUSES.indexOf(status);
}
