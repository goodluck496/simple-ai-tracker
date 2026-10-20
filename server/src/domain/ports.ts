import type {
  Actor,
  AttachmentKind,
  CommentKind,
  EventType,
  LinkRelation,
  PlanRevision,
  QuestionPhase,
  SearchScope,
  Tag,
  TagWithStats,
  Task,
  TaskAttachment,
  TaskComment,
  TaskEvent,
  TaskFilters,
  TaskImage,
  TaskLink,
  TaskQuestion,
  TaskSummary,
} from '../domain/entities.js';
import type { TaskStatus } from '../domain/task-status.js';
import type { TaskType } from '../domain/task-type.js';

/** Порт: запись задачи. */
export interface CreateTaskRecord {
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

export interface TaskPatch {
  readonly title?: string;
  readonly description?: string;
  readonly type?: TaskType;
  readonly status?: TaskStatus;
  readonly parentId?: string | null;
  readonly position?: number;
  readonly requiresManualTest?: boolean;
  readonly updatedAt: string;
}

export interface TaskRepository {
  findById(id: string): Task | null;
  exists(id: string): boolean;
  insert(record: CreateTaskRecord): Task;
  update(id: string, patch: TaskPatch): Task | null;
  delete(id: string): boolean;
  /** Следующий свободный числовой номер задачи. */
  nextSeq(): number;
  /** Максимальная позиция в колонке статуса (для вставки в конец). */
  maxPosition(status: TaskStatus): number;
  /** Позиции соседей в колонке, отсортированные по возрастанию. */
  listPositionsInStatus(status: TaskStatus): readonly { readonly id: string; readonly position: number }[];
}

/** Порт: чтение задач в виде карточек/списков с агрегатами. */
export interface TaskQueryRepository {
  listSummaries(filters: TaskFilters): TaskSummary[];
  listSummariesByIds(ids: readonly string[]): TaskSummary[];
  getSummary(id: string): TaskSummary | null;
  countByStatus(): Record<string, number>;
}

export interface NewComment {
  readonly taskId: string;
  readonly author: string;
  readonly text: string;
  readonly kind: CommentKind;
  readonly createdAt: string;
}

export interface CommentRepository {
  add(comment: NewComment): TaskComment;
  listByTask(taskId: string, limit?: number): TaskComment[];
  countByTask(taskId: string): number;
}

export interface NewQuestion {
  readonly taskId: string;
  readonly text: string;
  readonly phase: QuestionPhase;
  readonly askedBy: string;
  readonly createdAt: string;
}

export interface QuestionRepository {
  add(question: NewQuestion): TaskQuestion;
  listByTask(taskId: string): TaskQuestion[];
  findById(questionId: number): TaskQuestion | null;
  answer(questionId: number, answer: string, answeredBy: string, answeredAt: string): TaskQuestion | null;
  /** Удаляет вопрос (пользователь может снять лишний). */
  removeById(questionId: number): boolean;
  countOpen(taskId: string): number;
}

export interface NewAttachment {
  readonly taskId: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly content: string;
  readonly sourcePath: string | null;
  readonly size: number;
  readonly createdAt: string;
}

export interface AttachmentRepository {
  /** Добавляет вложение; для kind='plan' версия инкрементируется, прошлые планы теряют is_current. */
  add(attachment: NewAttachment): TaskAttachment;
  listByTask(taskId: string): TaskAttachment[];
  currentPlan(taskId: string): TaskAttachment | null;
  planHistory(taskId: string): PlanRevision[];
  countByTask(taskId: string): number;
  /** Удаляет вложение по id. */
  removeAttachment(attachmentId: number): boolean;
}

export interface ImageRepository {
  add(taskId: string, url: string, createdAt: string): TaskImage;
  listByTask(taskId: string): TaskImage[];
  /** Полная замена набора скриншотов карточки (используется формой редактирования). */
  replaceForTask(taskId: string, urls: readonly string[], createdAt: string): TaskImage[];
}

export interface NewLink {
  readonly taskId: string;
  readonly linkedTaskId: string;
  readonly relation: LinkRelation;
  readonly createdAt: string;
}

export interface LinkRepository {
  add(link: NewLink): TaskLink;
  remove(taskId: string, linkedTaskId: string, relation?: LinkRelation): number;
  listByTask(taskId: string): TaskLink[];
  /** Обратные связи: карточки, которые ссылаются на данную. */
  listIncoming(taskId: string): TaskLink[];
}

export interface NewEvent {
  readonly taskId: string;
  readonly type: EventType;
  readonly actor: Actor;
  readonly summary: string;
  readonly payload?: Record<string, unknown>;
  readonly createdAt: string;
}

export interface EventRepository {
  add(event: NewEvent): TaskEvent;
  listByTask(taskId: string, limit?: number): TaskEvent[];
}

export interface TagRepository {
  listAll(): Tag[];
  listWithStats(): TagWithStats[];
  findByName(name: string): Tag | null;
  upsert(name: string, color: string, description: string, createdAt: string): Tag;
  update(id: number, patch: { color?: string; description?: string }): Tag | null;
  removeByName(name: string): boolean;
  attachToTask(taskId: string, tagId: number): void;
  detachFromTask(taskId: string, tagId: number): void;
  replaceTaskTags(taskId: string, tagIds: readonly number[]): void;
  listByTask(taskId: string): Tag[];
  listByTasks(taskIds: readonly string[]): Map<string, Tag[]>;
}

export interface SearchIndex {
  /** Переиндексирует одну карточку (заголовок, описание, комментарии, теги). */
  reindexTask(taskId: string): void;
  removeTask(taskId: string): void;
  /**
   * Полнотекстовый поиск, возвращает ID в порядке релевантности.
   * `scopes` — набор полей: заголовок, описание, комментарии, теги и/или ID.
   */
  search(query: string, scopes: readonly SearchScope[] | SearchScope, limit: number): string[];
  rebuildAll(): number;
}

export interface MetaRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
  all(): Record<string, string>;
}

/** Набор всех портов хранилища. */
export interface Repositories {
  readonly tasks: TaskRepository;
  readonly taskQueries: TaskQueryRepository;
  readonly comments: CommentRepository;
  readonly questions: QuestionRepository;
  readonly attachments: AttachmentRepository;
  readonly images: ImageRepository;
  readonly links: LinkRepository;
  readonly events: EventRepository;
  readonly tags: TagRepository;
  readonly search: SearchIndex;
  readonly meta: MetaRepository;
}
