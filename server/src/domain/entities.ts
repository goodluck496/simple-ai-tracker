import type { TaskStatus } from './task-status.js';
import type { TaskType } from './task-type.js';

/** Автор действия: агент, пользователь или системный процесс. */
export type Actor = 'agent' | 'user' | 'system';

/** Виды комментариев карточки. */
export const COMMENT_KINDS = [
  'note',
  'status',
  'requirement',
  'clarification',
  'plan',
  'test-report',
  'answer',
  'system',
] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/** Виды вложений: план (версионируется), отчёт (тесты/результаты), прочее. */
export const ATTACHMENT_KINDS = ['plan', 'report', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Связи между карточками. */
export const LINK_RELATIONS = ['related', 'blocks', 'blocked_by', 'duplicates', 'duplicated_by'] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** Фаза, в которой задан вопрос пользователю. */
export const QUESTION_PHASES = ['planning', 'implementation', 'testing'] as const;
export type QuestionPhase = (typeof QUESTION_PHASES)[number];

/** Типы событий журнала карточки (audit trail). */
export const EVENT_TYPES = [
  'created',
  'updated',
  'status_changed',
  'comment_added',
  'question_asked',
  'question_answered',
  'plan_attached',
  'clarification',
  'attachment_added',
  'link_added',
  'link_removed',
  'moved',
  'deleted',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Базовая карточка задачи (без связанных сущностей). */
export interface Task {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
  readonly description: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly parentId: string | null;
  readonly position: number;
  readonly requiresManualTest: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Tag {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly createdAt: string;
}

/** Тег вместе со статистикой использования. */
export interface TagWithStats extends Tag {
  readonly tasksCount: number;
}

export interface TaskComment {
  readonly id: number;
  readonly taskId: string;
  readonly author: string;
  readonly text: string;
  readonly kind: CommentKind;
  readonly createdAt: string;
}

export interface TaskQuestion {
  readonly id: number;
  readonly taskId: string;
  readonly text: string;
  readonly phase: QuestionPhase;
  readonly askedBy: string;
  readonly answer: string | null;
  readonly answeredAt: string | null;
  readonly answeredBy: string | null;
  readonly createdAt: string;
  readonly isOpen: boolean;
}

export interface TaskAttachment {
  readonly id: number;
  readonly taskId: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly version: number;
  readonly isCurrent: boolean;
  readonly content: string;
  readonly sourcePath: string | null;
  readonly size: number;
  readonly createdAt: string;
}

export interface TaskImage {
  readonly id: number;
  readonly taskId: string;
  readonly url: string;
  readonly createdAt: string;
}

export interface TaskLink {
  readonly id: number;
  readonly taskId: string;
  readonly linkedTaskId: string;
  readonly relation: LinkRelation;
  readonly createdAt: string;
}

export interface TaskEvent {
  readonly id: number;
  readonly taskId: string;
  readonly type: EventType;
  readonly actor: Actor;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

/** Краткая карточка для списков и канбана. */
export interface TaskSummary {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
  readonly description: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly parentId: string | null;
  readonly position: number;
  readonly requiresManualTest: boolean;
  readonly tags: readonly Tag[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commentsCount: number;
  readonly imagesCount: number;
  readonly attachmentsCount: number;
  readonly questionsCount: number;
  readonly openQuestionsCount: number;
  readonly subtasksCount: number;
  readonly hasPlan: boolean;
  readonly currentPlanVersion: number | null;
}

/** Полная карточка задачи. */
export interface TaskCard extends Task {
  readonly tags: readonly Tag[];
  readonly comments: readonly TaskComment[];
  readonly questions: readonly TaskQuestion[];
  readonly attachments: readonly TaskAttachment[];
  readonly images: readonly TaskImage[];
  readonly links: readonly TaskLink[];
  readonly events: readonly TaskEvent[];
  readonly subtasks: readonly TaskSummary[];
  readonly parent: TaskSummary | null;
  readonly plan: PlanSnapshot | null;
  readonly planHistory: readonly PlanRevision[];
  readonly openQuestionsCount: number;
  readonly unansweredQuestions: readonly TaskQuestion[];
}

export interface PlanSnapshot {
  readonly attachmentId: number;
  readonly name: string;
  readonly version: number;
  readonly content: string;
  readonly sourcePath: string | null;
  readonly createdAt: string;
}

export interface PlanRevision {
  readonly attachmentId: number;
  readonly name: string;
  readonly version: number;
  readonly isCurrent: boolean;
  readonly size: number;
  readonly sourcePath: string | null;
  readonly createdAt: string;
}

/** Фильтры списка и поиска задач. */
export interface TaskFilters {
  readonly status?: TaskStatus;
  readonly type?: TaskType;
  readonly parentId?: string | null;
  readonly tag?: string;
  readonly query?: string;
  /** Область поиска (одна или несколько колонок). */
  readonly scope?: SearchScope;
  /** Мультивыбор полей поиска — приоритетнее `scope`. */
  readonly scopes?: readonly SearchScope[];
  readonly limit?: number;
}

export const SEARCH_SCOPES = ['all', 'title', 'description', 'comments', 'tags', 'id'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** Колонки FTS-индекса, по которым реально ищет полнотекстовый запрос. */
export const SEARCHABLE_COLUMNS = ['title', 'description', 'comments', 'tags'] as const;
export type SearchableColumn = (typeof SEARCHABLE_COLUMNS)[number];
