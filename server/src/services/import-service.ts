import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import type { Repositories } from '../domain/ports.js';
import type { Clock } from './task-service.js';
import { systemClock } from './task-service.js';
import type { CommentKind, EventType } from '../domain/entities.js';
import { isTaskStatus, type TaskStatus } from '../domain/task-status.js';
import { isTaskType, type TaskType } from '../domain/task-type.js';

/** Соответствие статусов legacy-трекера (JSON) статусам Simple AI Tracker. */
export const LEGACY_STATUS_MAP: Record<string, TaskStatus> = {
  todo: 'backlog',
  pending: 'questions',
  diffofready: 'ready',
  progress: 'in_progress',
  test: 'testing',
  review: 'review',
  done: 'done',
  backlog: 'backlog',
  planning: 'planning',
  questions: 'questions',
  ready: 'ready',
  in_progress: 'in_progress',
  testing: 'testing',
};

interface LegacyComment {
  id?: string;
  author?: string;
  text?: string;
  createdAt?: string;
}

interface LegacyQuestion {
  id?: string;
  text?: string;
  answer?: string;
  answeredAt?: string;
  createdAt?: string;
}

interface LegacyAttachment {
  id?: string;
  name?: string;
  path?: string;
  content?: string;
  size?: number;
  createdAt?: string;
}

interface LegacyTask {
  id?: string;
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  parentId?: string | null;
  order?: number;
  images?: string[];
  tags?: string[];
  attachments?: LegacyAttachment[];
  comments?: LegacyComment[];
  questions?: LegacyQuestion[];
  createdAt?: string;
  updatedAt?: string;
}

interface LegacyTag {
  id?: string;
  name?: string;
  color?: string;
  description?: string;
}

export interface ImportOptions {
  /** Каталог legacy-проекта, содержащий tasks.json, tasks/ и tags.json. */
  readonly sourceDir: string;
  /** Удалить существующие задачи перед импортом. */
  readonly replace?: boolean;
  /** Флаг ручного тестирования по умолчанию для импортированных карточек. */
  readonly requiresManualTest?: boolean;
}

export interface ImportReport {
  readonly sourceDir: string;
  readonly tasksImported: number;
  readonly tasksSkipped: number;
  readonly tagsImported: number;
  readonly comments: number;
  readonly questions: number;
  readonly plans: number;
  readonly attachments: number;
  readonly images: number;
  readonly links: number;
  readonly warnings: readonly string[];
  readonly byStatus: Record<string, number>;
}

/**
 * Импорт из legacy JSON-хранилища (tasks.json + tasks/*.json + tags.json).
 *
 * Пишет напрямую через репозитории, минуя workflow: исторические статусы и
 * комментарии — это факты прошлого, их нельзя «пере-валидировать» правилами
 * переходов. Поисковый индекс перестраивается в конце.
 */
export class ImportService {
  public constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock = systemClock,
    private readonly logger?: Logger,
  ) {}

  public importFromJson(options: ImportOptions): ImportReport {
    const sourceDir = path.resolve(options.sourceDir);
    const warnings: string[] = [];

    const legacyTags = this.readJson<{ tags?: LegacyTag[] }>(path.join(sourceDir, 'tags.json'))?.tags ?? [];
    const legacyTasks = this.collectLegacyTasks(sourceDir, warnings);

    if (options.replace) {
      const existing = this.repos.taskQueries.listSummaries({});
      for (const task of existing) this.repos.tasks.delete(task.id);
      this.repos.search.rebuildAll();
      this.logger?.info('Legacy-импорт: существующие задачи удалены', { removed: existing.length });
    }

    const now = this.clock.now();
    let tagsImported = 0;
    for (const tag of legacyTags) {
      const name = String(tag.name ?? tag.id ?? '').trim().toLowerCase();
      if (!name) continue;
      this.repos.tags.upsert(name, tag.color ?? '', tag.description ?? '', now);
      tagsImported += 1;
    }

    const ordered = [...legacyTasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || seqFromId(a.id) - seqFromId(b.id));
    const usedSeq = new Set<number>();
    let fallbackSeq = 0;

    const byStatus: Record<string, number> = {};
    let tasksImported = 0;
    let tasksSkipped = 0;
    let comments = 0;
    let questions = 0;
    let plans = 0;
    let attachments = 0;
    let images = 0;
    let links = 0;

    const positionByStatus = new Map<TaskStatus, number>();

    for (const legacyTask of ordered) {
      const id = String(legacyTask.id ?? '').trim();
      if (!id) {
        tasksSkipped += 1;
        continue;
      }
      if (this.repos.tasks.exists(id)) {
        tasksSkipped += 1;
        warnings.push(`Задача ${id} уже существует — пропущена.`);
        continue;
      }

      const status = LEGACY_STATUS_MAP[String(legacyTask.status ?? '').toLowerCase()] ?? 'backlog';
      const type: TaskType = isTaskType(legacyTask.type) ? legacyTask.type : 'task';

      let seq = seqFromId(id);
      while (usedSeq.has(seq) || seq <= 0) seq = ++fallbackSeq;
      usedSeq.add(seq);

      const position = (positionByStatus.get(status) ?? 0) + 1000;
      positionByStatus.set(status, position);

      this.repos.tasks.insert({
        id,
        seq,
        title: String(legacyTask.title ?? '').trim() || id,
        description: String(legacyTask.description ?? ''),
        type,
        status,
        parentId: null,
        position,
        requiresManualTest: options.requiresManualTest ?? false,
        createdAt: legacyTask.createdAt ?? now,
        updatedAt: legacyTask.updatedAt ?? legacyTask.createdAt ?? now,
      });

      // Теги: из карточки (legacy tags[]) и из legacy tags.json (не хранится в карточке).
      const tagNames = new Set<string>();
      for (const name of legacyTask.tags ?? []) {
        const normalized = String(name).trim().toLowerCase();
        if (normalized) tagNames.add(normalized);
      }
      if (tagNames.size > 0) {
        const tagIds = [...tagNames].map((name) => this.repos.tags.upsert(name, '', '', now).id);
        this.repos.tags.replaceTaskTags(id, tagIds);
      }

      for (const comment of legacyTask.comments ?? []) {
        const text = String(comment.text ?? '').trim();
        if (!text) continue;
        const kind = detectCommentKind(text);
        const createdAt = comment.createdAt ?? now;
        const author = String(comment.author ?? 'AI Agent');
        this.repos.comments.add({ taskId: id, author, text, kind, createdAt });
        comments += 1;

        // Из значимых комментариев восстанавливаем журнал решений,
        // иначе decisionLog импортированных карточек был бы пустым.
        const eventType = eventTypeForCommentKind(kind);
        if (eventType) {
          this.repos.events.add({
            taskId: id,
            type: eventType,
            actor: author.toLowerCase().includes('user') ? 'user' : 'agent',
            summary: text.slice(0, 200),
            payload: { imported: true, commentKind: kind, fullText: text },
            createdAt,
          });
        }
      }

      for (const question of legacyTask.questions ?? []) {
        const text = String(question.text ?? '').trim();
        if (!text) continue;
        const created = this.repos.questions.add({
          taskId: id,
          text,
          phase: 'planning',
          askedBy: 'AI Agent',
          createdAt: question.createdAt ?? now,
        });
        const answer = String(question.answer ?? '').trim();
        if (answer) {
          this.repos.questions.answer(created.id, answer, 'User', question.answeredAt ?? now);
        }
        questions += 1;
      }

      for (const attachment of legacyTask.attachments ?? []) {
        const name = String(attachment.name ?? 'attachment.md');
        const isPlan = name.toLowerCase().endsWith('.md');
        const content = this.readAttachmentContent(sourceDir, attachment, warnings, id);
        const createdAt = attachment.createdAt ?? now;
        this.repos.attachments.add({
          taskId: id,
          name,
          kind: isPlan ? 'plan' : 'file',
          content,
          sourcePath: attachment.path ?? null,
          size: attachment.size ?? Buffer.byteLength(content, 'utf8'),
          createdAt,
        });
        if (isPlan) {
          plans += 1;
          this.repos.events.add({
            taskId: id,
            type: 'plan_attached',
            actor: 'agent',
            summary: `Импортирован план «${name}».`,
            payload: { imported: true, name, sourcePath: attachment.path ?? null },
            createdAt,
          });
        } else {
          attachments += 1;
        }
      }

      for (const image of legacyTask.images ?? []) {
        if (!image) continue;
        this.repos.images.add(id, String(image), now);
        images += 1;
      }

      this.repos.events.add({
        taskId: id,
        type: 'created',
        actor: 'system',
        summary: 'Карточка импортирована из legacy JSON-хранилища.',
        payload: { source: 'legacy-json', legacyStatus: legacyTask.status ?? null, legacyOrder: legacyTask.order ?? null },
        createdAt: legacyTask.createdAt ?? now,
      });

      byStatus[status] = (byStatus[status] ?? 0) + 1;
      tasksImported += 1;
    }

    // Связи "родитель-потомок": отдельным проходом, чтобы FK не мешал порядку вставки.
    for (const legacyTask of ordered) {
      const id = String(legacyTask.id ?? '').trim();
      const parentId = legacyTask.parentId ? String(legacyTask.parentId) : null;
      if (!id || !parentId) continue;
      if (!this.repos.tasks.exists(id)) continue;
      if (!this.repos.tasks.exists(parentId)) {
        warnings.push(`Родительская задача ${parentId} для ${id} не найдена — связь пропущена.`);
        continue;
      }
      this.repos.tasks.update(id, { parentId, updatedAt: legacyTask.updatedAt ?? now });
      links += 1;
    }

    const indexed = this.repos.search.rebuildAll();

    return {
      sourceDir,
      tasksImported,
      tasksSkipped,
      tagsImported,
      comments,
      questions,
      plans,
      attachments,
      images,
      links,
      warnings: [...warnings, `Проиндексировано карточек: ${indexed}.`],
      byStatus,
    };
  }

  private collectLegacyTasks(sourceDir: string, warnings: string[]): LegacyTask[] {
    const tasksDir = path.join(sourceDir, 'tasks');
    const tasks: LegacyTask[] = [];

    if (fs.existsSync(tasksDir) && fs.statSync(tasksDir).isDirectory()) {
      for (const file of fs.readdirSync(tasksDir)) {
        if (!file.endsWith('.json')) continue;
        const parsed = this.readJson<LegacyTask>(path.join(tasksDir, file));
        if (parsed && parsed.id) tasks.push(parsed);
        else warnings.push(`Файл tasks/${file} пропущен: нет поля id.`);
      }
    }

    if (tasks.length === 0) {
      const summary = this.readJson<{ tasks?: LegacyTask[] }>(path.join(sourceDir, 'tasks.json'));
      if (summary?.tasks) tasks.push(...summary.tasks);
    }

    return tasks;
  }

  private readAttachmentContent(
    sourceDir: string,
    attachment: LegacyAttachment,
    warnings: string[],
    taskId: string,
  ): string {
    if (attachment.content && attachment.content.trim()) return attachment.content;
    const relativePath = attachment.path;
    if (relativePath) {
      const absolutePath = path.resolve(sourceDir, relativePath);
      if (fs.existsSync(absolutePath)) {
        try {
          return fs.readFileSync(absolutePath, 'utf8');
        } catch {
          warnings.push(`Не удалось прочитать план ${relativePath} для ${taskId}.`);
        }
      } else {
        warnings.push(`Файл вложения ${relativePath} для ${taskId} не найден на диске.`);
      }
    }
    return `_Содержимое вложения не сохранилось в legacy-хранилище (${attachment.name ?? 'attachment'})._`;
  }

  private readJson<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (error) {
      this.logger?.warn('Не удалось разобрать JSON', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function seqFromId(id: string | undefined): number {
  const match = String(id ?? '').match(/(\d+)\s*$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/** Определяет вид комментария по legacy-префиксу. */export function detectCommentKind(text: string): CommentKind {
  const upper = text.slice(0, 60).toUpperCase();
  if (upper.includes('[USER REQUIREMENTS]')) return 'requirement';
  if (upper.includes('[CLARIFICATION]')) return 'clarification';
  if (upper.includes('[PLAN') || upper.includes('[PENDING]')) return 'plan';
  if (upper.includes('[TEST') || upper.includes('[RESULT')) return 'test-report';
  if (upper.includes('[ANSWERS')) return 'answer';
  if (/^\[(BACKLOG|PLANNING|QUESTIONS|READY|TODO|PENDING|DIFFOFREADY|PROGRESS|TEST|REVIEW|DONE)\]/i.test(text.trim())) {
    return 'status';
  }
  return 'note';
}

/** Проверка, что значение статуса известно (используется тестами и CLI). */
export function mapLegacyStatus(value: string): TaskStatus {
  const mapped = LEGACY_STATUS_MAP[value.toLowerCase()];
  if (mapped) return mapped;
  return isTaskStatus(value) ? value : 'backlog';
}

/** Сопоставление вида legacy-комментария с типом события журнала решений. */
export function eventTypeForCommentKind(kind: CommentKind): EventType | null {
  switch (kind) {
    case 'clarification':
    case 'requirement':
      return 'clarification';
    case 'plan':
      return 'plan_attached';
    case 'status':
      return 'status_changed';
    case 'test-report':
      return 'attachment_added';
    case 'answer':
      return 'question_answered';
    default:
      return null;
  }
}
