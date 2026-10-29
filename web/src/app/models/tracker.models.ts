/** Модели Simple AI Tracker (зеркало серверного домена). */

import type { TaskStatus } from '../../../../shared/tasks/status';
export { TaskStatus } from '../../../../shared/tasks/status';

export type TaskType = 'feature' | 'task' | 'bug';

export type CommentKind =
  | 'note'
  | 'status'
  | 'requirement'
  | 'clarification'
  | 'plan'
  | 'test-report'
  | 'answer'
  | 'system';

export type LinkRelation = 'related' | 'blocks' | 'blocked_by' | 'duplicates' | 'duplicated_by';

export type QuestionPhase = 'planning' | 'implementation' | 'testing';

export type SearchScope = 'all' | 'title' | 'description' | 'comments' | 'tags' | 'id';

export type StatusOwner = 'agent' | 'user' | 'both';

export interface StatusMeta {
  readonly status: TaskStatus;
  readonly title: string;
  readonly shortTitle: string;
  readonly description: string;
  readonly icon: string;
  readonly severity: 'secondary' | 'info' | 'warn' | 'success' | 'danger';
  readonly owner: StatusOwner;
  readonly agentGuidance: string;
}

export interface TypeMeta {
  readonly type: TaskType;
  readonly title: string;
  readonly icon: string;
  readonly severity: string;
}

export interface Tag {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly createdAt: string;
  readonly tasksCount?: number;
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
  readonly kind: 'plan' | 'report' | 'file';
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
  readonly type: string;
  readonly actor: 'agent' | 'user' | 'system';
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
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
  readonly trustedExecution?: boolean;
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

export interface TaskCard extends TaskSummary {
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
  readonly unansweredQuestions: readonly TaskQuestion[];
}

export interface TrackerMeta {
  readonly app: { readonly name: string; readonly version: string; readonly idPrefix: string };
  readonly statuses: readonly StatusMeta[];
  readonly types: readonly TypeMeta[];
  readonly enums: {
    readonly linkRelations: readonly LinkRelation[];
    readonly questionPhases: readonly QuestionPhase[];
    readonly commentKinds: readonly CommentKind[];
    readonly attachmentKinds: readonly string[];
    readonly searchScopes: readonly SearchScope[];
  };
}

export interface TaskFilters {
  readonly status?: TaskStatus;
  readonly type?: TaskType;
  readonly tag?: string;
  readonly parentId?: string;
  readonly query?: string;
  /** Мультивыбор полей поиска (как в прежнем UI: «Поиск в: …»). */
  readonly scopes?: readonly SearchScope[];
  readonly limit?: number;
}

export interface SearchScopeOption {
  readonly key: SearchScope;
  readonly label: string;
  readonly icon: string;
  readonly tooltip: string;
}

/** Поля, по которым можно искать — порт прежнего списка областей поиска. */
export const SEARCH_SCOPE_OPTIONS: readonly SearchScopeOption[] = [
  { key: 'title', label: 'Название', icon: 'pi pi-pencil', tooltip: 'Искать в названии задачи' },
  { key: 'description', label: 'Описание', icon: 'pi pi-align-left', tooltip: 'Искать в описании и плане' },
  { key: 'comments', label: 'Комментарии', icon: 'pi pi-comments', tooltip: 'Искать в истории комментариев' },
  { key: 'tags', label: 'Теги', icon: 'pi pi-tags', tooltip: 'Искать по тегам задач' },
  { key: 'id', label: 'ID', icon: 'pi pi-hashtag', tooltip: 'Искать по ID (например SAT-12)' },
];

/** Все поля кроме служебного "all" — значение по умолчанию для поиска. */
export const DEFAULT_SEARCH_SCOPES: readonly SearchScope[] = ['title', 'description', 'comments', 'tags', 'id'];

export interface CreateTaskPayload {
  readonly title: string;
  readonly type: TaskType;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly parentId?: string | null;
  readonly tags?: readonly string[];
  readonly requiresManualTest?: boolean;
  readonly trustedExecution?: boolean;
  /** Скриншоты карточки (URL из /api/images). */
  readonly images?: readonly string[];
}

export interface UpdateTaskPayload {
  readonly title?: string;
  readonly description?: string;
  readonly type?: TaskType;
  readonly tags?: readonly string[];
  readonly requiresManualTest?: boolean;
  readonly trustedExecution?: boolean;
  readonly parentId?: string | null;
  /** Полный новый набор скриншотов (URL из /api/images). */
  readonly images?: readonly string[];
}

/** Резервная копия базы трекера. */
export interface BackupRecord {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly createdAt: string;
}

export interface BackupListResponse {
  readonly backups: readonly BackupRecord[];
  readonly directory: string;
  readonly keep: number;
  readonly autoEnabled: boolean;
  readonly intervalHours: number;
}

/** Человекочитаемые названия связей. */
export const LINK_RELATION_LABELS: Record<LinkRelation, string> = {
  related: 'связана с',
  blocks: 'блокирует',
  blocked_by: 'блокируется',
  duplicates: 'дублирует',
  duplicated_by: 'дублируется',
};

export const LINK_RELATION_OPTIONS: { value: LinkRelation; label: string }[] = [
  { value: 'related', label: 'Связана с' },
  { value: 'blocks', label: 'Блокирует' },
  { value: 'blocked_by', label: 'Блокируется' },
  { value: 'duplicates', label: 'Дублирует' },
  { value: 'duplicated_by', label: 'Дублируется' },
];

export const COMMENT_KIND_LABELS: Record<CommentKind, string> = {
  note: 'Заметка',
  status: 'Статус',
  requirement: 'Требование',
  clarification: 'Уточнение',
  plan: 'План',
  'test-report': 'Тесты',
  answer: 'Ответ',
  system: 'Система',
};
