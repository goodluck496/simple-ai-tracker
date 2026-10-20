import { TrackerError } from '../core/errors.js';

/** Тип карточки: фича, задача или баг. */
export const TASK_TYPES = ['feature', 'task', 'bug'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskTypeMeta {
  readonly type: TaskType;
  readonly title: string;
  readonly icon: string;
  readonly severity: 'secondary' | 'info' | 'warn' | 'danger' | 'contrast';
}

export const TASK_TYPE_META: Record<TaskType, TaskTypeMeta> = {
  feature: { type: 'feature', title: 'Фича', icon: 'pi pi-star-fill', severity: 'info' },
  task: { type: 'task', title: 'Задача', icon: 'pi pi-bolt', severity: 'secondary' },
  bug: { type: 'bug', title: 'Баг', icon: 'pi pi-exclamation-triangle', severity: 'danger' },
};

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

export function assertTaskType(value: unknown): TaskType {
  if (!isTaskType(value)) {
    throw new TrackerError('VALIDATION_FAILED', `Недопустимый тип задачи: "${String(value)}".`, { allowed: TASK_TYPES });
  }
  return value;
}
