/** One status vocabulary for the server domain and web client. */
export const TaskStatus = {
  Backlog: 'backlog', Planning: 'planning', Questions: 'questions', Ready: 'ready',
  InProgress: 'in_progress', Testing: 'testing', Review: 'review', Done: 'done',
} as const;
export type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];
export const TASK_STATUSES = Object.values(TaskStatus);
