import type {
  Actor,
  AttachmentKind,
  CommentKind,
  EventType,
  LinkRelation,
  QuestionPhase,
  Tag,
  Task,
  TaskAttachment,
  TaskComment,
  TaskEvent,
  TaskImage,
  TaskLink,
  TaskQuestion,
  TaskSummary,
} from '../domain/entities.js';
import type { TaskStatus } from '../domain/task-status.js';
import type { TaskType } from '../domain/task-type.js';

/** Строки SQLite → доменные объекты. Значения проверяются, чтобы БД не «протекала». */
export interface TaskRow {
  id: string;
  seq: number;
  title: string;
  description: string;
  type: string;
  status: string;
  parent_id: string | null;
  position: number;
  requires_manual_test: number;
  created_at: string;
  updated_at: string;
}

export interface SummaryRow extends TaskRow {
  comments_count: number;
  images_count: number;
  attachments_count: number;
  questions_count: number;
  open_questions_count: number;
  subtasks_count: number;
  plan_version: number | null;
}

export interface CommentRow {
  id: number;
  task_id: string;
  author: string;
  text: string;
  kind: string;
  created_at: string;
}

export interface QuestionRow {
  id: number;
  task_id: string;
  text: string;
  phase: string;
  asked_by: string;
  answer: string | null;
  answered_at: string | null;
  answered_by: string | null;
  created_at: string;
}

export interface AttachmentRow {
  id: number;
  task_id: string;
  name: string;
  kind: string;
  version: number;
  is_current: number;
  content: string;
  source_path: string | null;
  size: number;
  created_at: string;
}

export interface ImageRow {
  id: number;
  task_id: string;
  url: string;
  created_at: string;
}

export interface TagRow {
  id: number;
  name: string;
  color: string;
  description: string;
  created_at: string;
}

export interface LinkRow {
  id: number;
  task_id: string;
  linked_task_id: string;
  relation: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  task_id: string;
  type: string;
  actor: string;
  summary: string;
  payload: string;
  created_at: string;
}

export function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    description: row.description,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    parentId: row.parent_id,
    position: row.position,
    requiresManualTest: row.requires_manual_test === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapComment(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    text: row.text,
    kind: row.kind as CommentKind,
    createdAt: row.created_at,
  };
}

export function mapQuestion(row: QuestionRow): TaskQuestion {
  const answer = row.answer ?? null;
  const isOpen = answer === null || answer.trim().length === 0;
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    phase: row.phase as QuestionPhase,
    askedBy: row.asked_by,
    answer,
    answeredAt: row.answered_at,
    answeredBy: row.answered_by,
    createdAt: row.created_at,
    isOpen,
  };
}

export function mapAttachment(row: AttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    kind: row.kind as AttachmentKind,
    version: row.version,
    isCurrent: row.is_current === 1,
    content: row.content,
    sourcePath: row.source_path,
    size: row.size,
    createdAt: row.created_at,
  };
}

export function mapImage(row: ImageRow): TaskImage {
  return { id: row.id, taskId: row.task_id, url: row.url, createdAt: row.created_at };
}

export function mapTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    createdAt: row.created_at,
  };
}

export function mapLink(row: LinkRow): TaskLink {
  return {
    id: row.id,
    taskId: row.task_id,
    linkedTaskId: row.linked_task_id,
    relation: row.relation as LinkRelation,
    createdAt: row.created_at,
  };
}

export function mapEvent(row: EventRow): TaskEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = { raw: row.payload };
  }
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type as EventType,
    actor: row.actor as Actor,
    summary: row.summary,
    payload,
    createdAt: row.created_at,
  };
}

export function mapSummary(row: SummaryRow, tags: readonly Tag[]): TaskSummary {
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    description: row.description,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    parentId: row.parent_id,
    position: row.position,
    requiresManualTest: row.requires_manual_test === 1,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commentsCount: row.comments_count,
    imagesCount: row.images_count,
    attachmentsCount: row.attachments_count,
    questionsCount: row.questions_count,
    openQuestionsCount: row.open_questions_count,
    subtasksCount: row.subtasks_count,
    hasPlan: row.plan_version !== null,
    currentPlanVersion: row.plan_version,
  };
}
