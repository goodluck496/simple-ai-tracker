import type { Logger } from '../core/logger.js';
import { TrackerError } from '../core/errors.js';
import type { TrackerConfig } from '../core/config.js';
import type { Repositories } from '../domain/ports.js';
import type {
  Actor,
  CommentKind,
  LinkRelation,
  PlanSnapshot,
  QuestionPhase,
  Tag,
  TaskAttachment,
  TaskCard,
  TaskComment,
  TaskEvent,
  TaskFilters,
  TaskQuestion,
  TaskSummary,
  Task,
} from '../domain/entities.js';
import { assertTaskStatus, assertTransition, type TaskStatus } from '../domain/task-status.js';
import { assertTaskType, type TaskType } from '../domain/task-type.js';

const POSITION_STEP = 1000;
const REQUIREMENTS_SECTION = '### Дополнительные требования пользователя (добавлено в процессе):';

export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export interface CreateTaskRequest {
  readonly title: string;
  readonly type?: TaskType;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly parentId?: string | null;
  readonly tags?: readonly string[];
  readonly requiresManualTest?: boolean;
  readonly relatedTaskIds?: readonly string[];
  readonly initialComment?: string;
  /** Скриншоты карточки (URL из /api/images). */
  readonly images?: readonly string[];
  readonly actor?: Actor;
  /** Явный ID (используется при импорте из legacy JSON). */
  readonly id?: string;
}

export interface UpdateTaskRequest {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: TaskType;
  readonly tags?: readonly string[];
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
  readonly requiresManualTest?: boolean;
  readonly parentId?: string | null;
  /** Полный новый набор скриншотов (URL из /api/images). */
  readonly images?: readonly string[];
  readonly actor?: Actor;
}

export interface SetStatusRequest {
  readonly id: string;
  readonly status: TaskStatus;
  readonly comment?: string;
  readonly actor?: Actor;
}

export interface AskQuestionsRequest {
  readonly id: string;
  readonly questions: readonly string[];
  readonly phase?: QuestionPhase;
  readonly askedBy?: string;
  readonly actor?: Actor;
}

export interface QuestionAnswer {
  readonly questionId?: number;
  readonly questionIndex?: number;
  readonly answer: string;
}

export interface AnswerQuestionsRequest {
  readonly id: string;
  readonly answers: readonly QuestionAnswer[];
  readonly answeredBy?: string;
  readonly actor?: Actor;
}

export interface AttachPlanRequest {
  readonly id: string;
  readonly planContent?: string;
  readonly planPath?: string;
  readonly fileName?: string;
  readonly summary?: string;
  readonly questions?: readonly string[];
  readonly phase?: QuestionPhase;
  /** Автопереход: вопросы → questions, иначе → ready. 'none' — статус не менять. */
  readonly statusMode?: 'auto' | 'none';
  readonly actor?: Actor;
}

export interface RecordClarificationRequest {
  readonly id: string;
  readonly clarification: string;
  readonly reason?: string;
  readonly impact?: string;
  readonly planChanged?: boolean;
  readonly questions?: readonly string[];
  readonly phase?: QuestionPhase;
  readonly actor?: Actor;
}

export interface AddCommentRequest {
  readonly id: string;
  readonly text: string;
  readonly author?: string;
  readonly kind?: CommentKind;
  readonly actor?: Actor;
}

export interface MoveTaskRequest {
  readonly id: string;
  readonly status?: TaskStatus;
  readonly beforeId?: string;
  readonly afterId?: string;
  readonly toIndex?: number;
  readonly actor?: Actor;
}

export interface TaskServiceDependencies {
  readonly config: TrackerConfig;
  readonly repos: Repositories;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Позволяет тестам отключить автоиндексацию. */
  readonly searchIndexing?: boolean;
}

/**
 * Доменный сервис карточек: единственная точка мутаций задач.
 * HTTP API и MCP-сервер вызывают только его методы — правила жизненного цикла
 * живут здесь, а не в транспортах.
 */
export class TaskService {
  private readonly config: TrackerConfig;
  private readonly repos: Repositories;
  private readonly clock: Clock;
  private readonly logger?: Logger;
  private readonly searchIndexing: boolean;

  public constructor(deps: TaskServiceDependencies) {
    this.config = deps.config;
    this.repos = deps.repos;
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger;
    this.searchIndexing = deps.searchIndexing ?? true;
  }

  // ---------------------------------------------------------------- создание

  public createTask(request: CreateTaskRequest): TaskCard {
    const title = (request.title ?? '').trim();
    if (!title) throw new TrackerError('VALIDATION_FAILED', 'Название задачи не может быть пустым.');

    const type = assertTaskType(request.type ?? 'task');
    const status = assertTaskStatus(request.status ?? 'backlog');
    const parentId = request.parentId ?? null;
    if (parentId && !this.repos.tasks.exists(parentId)) {
      throw new TrackerError('TASK_NOT_FOUND', `Родительская задача ${parentId} не найдена.`, { parentId });
    }

    const now = this.clock.now();
    const seq = this.repos.tasks.nextSeq();
    const id = request.id ?? `${this.config.idPrefix}-${seq}`;
    if (this.repos.tasks.exists(id)) {
      throw new TrackerError('CONFLICT', `Задача с ID ${id} уже существует.`, { id });
    }

    const position = this.repos.tasks.maxPosition(status) + POSITION_STEP;
    const task = this.repos.tasks.insert({
      id,
      seq,
      title,
      description: request.description ?? '',
      type,
      status,
      parentId,
      position,
      requiresManualTest: request.requiresManualTest ?? false,
      createdAt: now,
      updatedAt: now,
    });

    if (request.tags && request.tags.length > 0) {
      this.applyTagNames(id, request.tags);
    }

    if (request.images && request.images.length > 0) {
      this.repos.images.replaceForTask(id, request.images, now);
    }

    for (const relatedId of request.relatedTaskIds ?? []) {
      if (!this.repos.tasks.exists(relatedId)) continue;
      this.linkTasks(id, relatedId, 'related', request.actor ?? 'agent');
    }

    this.recordEvent(id, 'created', request.actor ?? 'agent', `Создана карточка «${title}» (${type}, ${status}).`, {
      type,
      status,
      parentId,
    });

    if (request.initialComment) {
      this.addComment({
        id,
        text: request.initialComment,
        author: request.actor === 'user' ? 'User' : 'AI Agent',
        kind: 'note',
        actor: request.actor ?? 'agent',
      });
    }

    this.reindex(id);
    return this.getTaskCard(id);
  }

  // ------------------------------------------------------------------ чтение

  public getTaskCard(id: string): TaskCard {
    const task = this.repos.tasks.findById(id);
    if (!task) throw new TrackerError('TASK_NOT_FOUND', `Задача ${id} не найдена.`, { id });

    const summary = this.repos.taskQueries.getSummary(id);
    const parent = task.parentId ? this.repos.taskQueries.getSummary(task.parentId) : null;
    const currentPlan = this.repos.attachments.currentPlan(id);
    const questions = this.repos.questions.listByTask(id);

    const plan: PlanSnapshot | null = currentPlan
      ? {
          attachmentId: currentPlan.id,
          name: currentPlan.name,
          version: currentPlan.version,
          content: currentPlan.content,
          sourcePath: currentPlan.sourcePath,
          createdAt: currentPlan.createdAt,
        }
      : null;

    return {
      ...task,
      tags: this.repos.tags.listByTask(id),
      comments: this.repos.comments.listByTask(id),
      questions,
      attachments: this.repos.attachments.listByTask(id),
      images: this.repos.images.listByTask(id),
      links: [...this.repos.links.listByTask(id), ...this.repos.links.listIncoming(id)],
      events: this.repos.events.listByTask(id),
      subtasks: summary && summary.subtasksCount > 0 ? this.repos.taskQueries.listSummaries({ parentId: id }) : [],
      parent,
      plan,
      planHistory: this.repos.attachments.planHistory(id),
      openQuestionsCount: questions.filter((question) => question.isOpen).length,
      unansweredQuestions: questions.filter((question) => question.isOpen),
    };
  }

  public getSummary(id: string): TaskSummary | null {
    return this.repos.taskQueries.getSummary(id);
  }

  public listTasks(filters: TaskFilters): TaskSummary[] {
    if (filters.query && filters.query.trim()) {
      return this.searchTasks(filters);
    }
    return this.repos.taskQueries.listSummaries(filters);
  }

  public searchTasks(filters: TaskFilters): TaskSummary[] {
    const query = (filters.query ?? '').trim();
    const scopes = filters.scopes ?? (filters.scope ? [filters.scope] : ['all']);
    const limit = filters.limit ?? 100;
    if (!query) return this.repos.taskQueries.listSummaries({ ...filters, query: undefined, limit });

    const ids = this.repos.search.search(query, scopes, Math.max(limit * 2, 50));
    let summaries = this.repos.taskQueries.listSummariesByIds(ids);

    summaries = summaries.filter((summary) => {
      if (filters.status && summary.status !== filters.status) return false;
      if (filters.type && summary.type !== filters.type) return false;
      if (filters.parentId && summary.parentId !== filters.parentId) return false;
      if (filters.tag) {
        const tag = filters.tag.trim().toLowerCase();
        if (!summary.tags.some((item) => item.name === tag)) return false;
      }
      return true;
    });

    return summaries.slice(0, limit);
  }

  public getStats(): { total: number; byStatus: Record<string, number>; tags: number } {
    return {
      total: Object.values(this.repos.taskQueries.countByStatus()).reduce((sum, value) => sum + value, 0),
      byStatus: this.repos.taskQueries.countByStatus(),
      tags: this.repos.tags.listAll().length,
    };
  }

  // ------------------------------------------------------------- обновление

  public updateTask(request: UpdateTaskRequest): TaskCard {
    const task = this.requireTask(request.id);
    const now = this.clock.now();

    if (request.parentId !== undefined) {
      if (request.parentId === task.id) {
        throw new TrackerError('VALIDATION_FAILED', 'Задача не может быть родителем сама себе.');
      }
      if (request.parentId && !this.repos.tasks.exists(request.parentId)) {
        throw new TrackerError('TASK_NOT_FOUND', `Родительская задача ${request.parentId} не найдена.`);
      }
      if (request.parentId && this.isDescendant(request.parentId, task.id)) {
        throw new TrackerError('VALIDATION_FAILED', 'Нельзя сделать потомка родителем (цикл в дереве задач).');
      }
    }

    this.repos.tasks.update(task.id, {
      title: request.title?.trim(),
      description: request.description,
      type: request.type ? assertTaskType(request.type) : undefined,
      parentId: request.parentId === undefined ? undefined : request.parentId,
      requiresManualTest: request.requiresManualTest,
      updatedAt: now,
    });

    if (request.images) {
      this.repos.images.replaceForTask(task.id, request.images, now);
    }

    if (request.tags) {
      this.applyTagNames(task.id, request.tags);
    }
    if (request.addTags && request.addTags.length > 0) {
      const current = this.repos.tags.listByTask(task.id).map((tag) => tag.name);
      this.applyTagNames(task.id, [...current, ...request.addTags]);
    }
    if (request.removeTags && request.removeTags.length > 0) {
      const toRemove = new Set(request.removeTags.map((name) => name.trim().toLowerCase()));
      const remaining = this.repos.tags
        .listByTask(task.id)
        .map((tag) => tag.name)
        .filter((name) => !toRemove.has(name));
      this.applyTagNames(task.id, remaining);
    }

    this.recordEvent(task.id, 'updated', request.actor ?? 'agent', 'Карточка обновлена.', {
      fields: Object.keys(request).filter((key) => key !== 'id' && key !== 'actor'),
    });
    this.reindex(task.id);
    return this.getTaskCard(task.id);
  }

  public setStatus(request: SetStatusRequest): TaskCard {
    const task = this.requireTask(request.id);
    const status = assertTaskStatus(request.status);
    const actor = request.actor ?? 'agent';
    assertTransition(task.status, status, actor === 'system' ? 'user' : actor);

    const now = this.clock.now();
    this.repos.tasks.update(task.id, { status, updatedAt: now });

    if (request.comment && request.comment.trim()) {
      this.repos.comments.add({
        taskId: task.id,
        author: actor === 'user' ? 'User' : 'AI Agent',
        text: `[${status.toUpperCase()}] ${request.comment.trim()}`,
        kind: 'status',
        createdAt: now,
      });
    }

    this.recordEvent(task.id, 'status_changed', actor, `Статус: ${task.status} → ${status}.`, {
      from: task.status,
      to: status,
      comment: request.comment ?? null,
    });
    this.reindex(task.id);
    return this.getTaskCard(task.id);
  }

  public moveTask(request: MoveTaskRequest): TaskCard {
    const task = this.requireTask(request.id);
    const actor = request.actor ?? 'user';
    const targetStatus = request.status ? assertTaskStatus(request.status) : task.status;

    if (targetStatus !== task.status) {
      assertTransition(task.status, targetStatus, actor === 'system' ? 'user' : actor);
    }

    const position = this.computePosition(task.id, targetStatus, request);
    const now = this.clock.now();
    this.repos.tasks.update(task.id, { status: targetStatus, position, updatedAt: now });
    this.recordEvent(task.id, 'moved', actor, `Карточка перемещена: ${task.status} → ${targetStatus}.`, {
      from: task.status,
      to: targetStatus,
      position,
    });
    return this.getTaskCard(task.id);
  }

  public addComment(request: AddCommentRequest): TaskComment {
    const task = this.requireTask(request.id);
    const text = (request.text ?? '').trim();
    if (!text) throw new TrackerError('VALIDATION_FAILED', 'Текст комментария пуст.');

    const kind = request.kind ?? 'note';
    const comment = this.repos.comments.add({
      taskId: task.id,
      author: request.author ?? (request.actor === 'user' ? 'User' : 'AI Agent'),
      text,
      kind,
      createdAt: this.clock.now(),
    });

    this.recordEvent(task.id, 'comment_added', request.actor ?? 'agent', text.slice(0, 200), {
      commentId: comment.id,
      kind,
    });
    this.reindex(task.id);
    return comment;
  }

  // ---------------------------------------------------------------- вопросы

  public askQuestions(request: AskQuestionsRequest): { task: TaskCard; questions: TaskQuestion[] } {
    const task = this.requireTask(request.id);
    const texts = (request.questions ?? []).map((question) => question.trim()).filter(Boolean);
    if (texts.length === 0) {
      throw new TrackerError('VALIDATION_FAILED', 'Нужно передать хотя бы один вопрос.');
    }

    const now = this.clock.now();
    const askedBy = request.askedBy ?? (request.actor === 'user' ? 'User' : 'AI Agent');
    const phase: QuestionPhase = request.phase ?? (task.status === 'in_progress' ? 'implementation' : 'planning');

    const questions = texts.map((text) =>
      this.repos.questions.add({ taskId: task.id, text, phase, askedBy, createdAt: now }),
    );

    if (task.status !== 'questions') {
      this.repos.tasks.update(task.id, { status: 'questions', updatedAt: now });
    }

    this.repos.comments.add({
      taskId: task.id,
      author: askedBy,
      text: `[QUESTIONS] Заданы вопросы пользователю (${phase}):\n${texts.map((text, index) => `${index + 1}. ${text}`).join('\n')}`,
      kind: 'note',
      createdAt: now,
    });

    this.recordEvent(task.id, 'question_asked', request.actor ?? 'agent', `Задано вопросов: ${questions.length}.`, {
      questionIds: questions.map((question) => question.id),
      phase,
    });
    this.reindex(task.id);

    return { task: this.getTaskCard(task.id), questions };
  }

  public answerQuestions(request: AnswerQuestionsRequest): { task: TaskCard; answered: TaskQuestion[] } {
    const task = this.requireTask(request.id);
    const answers = request.answers ?? [];
    if (answers.length === 0) throw new TrackerError('VALIDATION_FAILED', 'Нужно передать хотя бы один ответ.');

    const openQuestions = this.repos.questions.listByTask(task.id);
    const now = this.clock.now();
    const answeredBy = request.answeredBy ?? (request.actor === 'user' ? 'User' : 'User');
    const answered: TaskQuestion[] = [];

    for (const entry of answers) {
      const target =
        (entry.questionId !== undefined
          ? openQuestions.find((question) => question.id === entry.questionId)
          : undefined) ??
        (entry.questionIndex !== undefined ? openQuestions[entry.questionIndex] : undefined) ??
        openQuestions.find((question) => question.isOpen);

      if (!target) {
        throw new TrackerError('QUESTION_NOT_FOUND', 'Не удалось сопоставить ответ с вопросом карточки.', {
          questionId: entry.questionId,
          questionIndex: entry.questionIndex,
        });
      }

      const answer = (entry.answer ?? '').trim();
      if (!answer) continue;
      const updated = this.repos.questions.answer(target.id, answer, answeredBy, now);
      if (updated) answered.push(updated);
    }

    if (answered.length > 0) {
      this.repos.comments.add({
        taskId: task.id,
        author: answeredBy,
        text: `[ANSWERS] Ответы пользователя:\n${answered
          .map((question) => `- Вопрос: ${question.text}\n  Ответ: ${question.answer ?? ''}`)
          .join('\n')}`,
        kind: 'answer',
        createdAt: now,
      });
    }

    const stillOpen = this.repos.questions.countOpen(task.id);
    let nextStatus = task.status;
    if (stillOpen === 0) {
      nextStatus = this.repos.attachments.currentPlan(task.id) ? 'ready' : 'planning';
      if (nextStatus !== task.status) {
        this.repos.tasks.update(task.id, { status: nextStatus, updatedAt: now });
      }
    }

    this.recordEvent(task.id, 'question_answered', request.actor ?? 'user', `Отвечено вопросов: ${answered.length}.`, {
      answeredIds: answered.map((question) => question.id),
      stillOpen,
      nextStatus,
    });
    this.reindex(task.id);

    return { task: this.getTaskCard(task.id), answered };
  }

  // ------------------------------------------------------------------ планы

  public attachPlan(request: AttachPlanRequest): { task: TaskCard; plan: TaskAttachment; questions: TaskQuestion[] } {
    const task = this.requireTask(request.id);
    const content = (request.planContent ?? '').trim();
    if (!content) {
      throw new TrackerError('VALIDATION_FAILED', 'Содержимое плана пусто: передайте planContent.');
    }

    const now = this.clock.now();
    const fileName = request.fileName?.trim() || `plan-${task.id}.md`;
    const attachment = this.repos.attachments.add({
      taskId: task.id,
      name: fileName,
      kind: 'plan',
      content,
      sourcePath: request.planPath ?? null,
      size: Buffer.byteLength(content, 'utf8'),
      createdAt: now,
    });

    const questionsInput = (request.questions ?? []).map((question) => question.trim()).filter(Boolean);
    let questions: TaskQuestion[] = [];

    if (request.statusMode !== 'none') {
      // План сам по себе не делает карточку готовой к работе: если остаются
      // открытые вопросы (в том числе заданные ранее), статус обязан быть questions.
      const openBeforeAttach = this.repos.questions.countOpen(task.id);
      const hasOpenQuestions = openBeforeAttach > 0 || questionsInput.length > 0;
      const statusMode = request.statusMode ?? 'auto';
      const nextStatus: TaskStatus =
        statusMode === 'auto' ? (hasOpenQuestions ? 'questions' : 'ready') : task.status;
      if (nextStatus !== task.status) {
        this.repos.tasks.update(task.id, { status: nextStatus, updatedAt: now });
      }
    }

    if (questionsInput.length > 0) {
      const phase: QuestionPhase = request.phase ?? 'planning';
      questions = questionsInput.map((text) =>
        this.repos.questions.add({
          taskId: task.id,
          text,
          phase,
          askedBy: request.actor === 'user' ? 'User' : 'AI Agent',
          createdAt: now,
        }),
      );
      if (request.statusMode !== 'none') {
        this.repos.tasks.update(task.id, { status: 'questions', updatedAt: now });
      }
    }

    const summaryLine = request.summary ? `\n\nКраткое резюме плана: ${request.summary.trim()}` : '';
    this.repos.comments.add({
      taskId: task.id,
      author: request.actor === 'user' ? 'User' : 'AI Agent',
      text:
        `[PLAN v${attachment.version}] Прикреплён план «${fileName}» (${attachment.size} байт).` +
        summaryLine +
        (questions.length > 0
          ? `\n\n[PLAN QUESTIONS] Вопросы к пользователю:\n${questions.map((question, index) => `${index + 1}. ${question.text}`).join('\n')}`
          : ''),
      kind: 'plan',
      createdAt: now,
    });

    this.recordEvent(task.id, 'plan_attached', request.actor ?? 'agent', `План v${attachment.version}: ${fileName}.`, {
      version: attachment.version,
      name: fileName,
      sourcePath: attachment.sourcePath,
      questionsCount: questions.length,
    });
    this.reindex(task.id);

    return { task: this.getTaskCard(task.id), plan: attachment, questions };
  }

  public addAttachment(
    id: string,
    input: {
      readonly name: string;
      readonly content: string;
      readonly kind?: 'plan' | 'report' | 'file';
      readonly sourcePath?: string;
    },
    actor: Actor = 'agent',
  ): TaskAttachment {
    const task = this.requireTask(id);
    const content = input.content ?? '';
    if (!content.trim()) throw new TrackerError('VALIDATION_FAILED', 'Содержимое вложения пусто.');

    const attachment = this.repos.attachments.add({
      taskId: task.id,
      name: input.name?.trim() || 'attachment.txt',
      kind: input.kind ?? 'file',
      content,
      sourcePath: input.sourcePath ?? null,
      size: Buffer.byteLength(content, 'utf8'),
      createdAt: this.clock.now(),
    });

    this.recordEvent(task.id, 'attachment_added', actor, `Вложение «${attachment.name}».`, {
      attachmentId: attachment.id,
      kind: attachment.kind,
    });
    return attachment;
  }

  // --------------------------------------------------- уточнения и решения

  /**
   * Фиксирует уточнение пользователя по ходу работы над задачей.
   *
   * Зачем: агент может «сбиться», но карточка обязана хранить полный след —
   * что просили изначально, что уточнили, почему решение поменялось и чем всё
   * закончилось. Уточнение попадает в описание (человекочитаемо), в журнал
   * событий (структурно) и, если указаны вопросы, переводит карточку в questions.
   */
  public recordClarification(request: RecordClarificationRequest): {
    task: TaskCard;
    event: TaskEvent;
    questions: TaskQuestion[];
  } {
    const task = this.requireTask(request.id);
    const clarification = (request.clarification ?? '').trim();
    if (!clarification) throw new TrackerError('VALIDATION_FAILED', 'Текст уточнения пуст.');

    const now = this.clock.now();
    const stamp = formatStamp(now);
    const reason = (request.reason ?? '').trim();
    const impact = (request.impact ?? '').trim();
    const bulletParts = [`- [${stamp}] ${clarification}`];
    if (reason) bulletParts.push(`Причина: ${reason}.`);
    if (impact) bulletParts.push(`Влияние на решение: ${impact}.`);
    const bullet = bulletParts.join(' ');

    const description = task.description.includes(REQUIREMENTS_SECTION)
      ? task.description.replace(REQUIREMENTS_SECTION, `${REQUIREMENTS_SECTION}\n${bullet}`)
      : `${task.description.trim()}\n\n${REQUIREMENTS_SECTION}\n${bullet}\n`;

    this.repos.tasks.update(task.id, { description, updatedAt: now });

    const comment = this.repos.comments.add({
      taskId: task.id,
      author: request.actor === 'user' ? 'User' : 'AI Agent',
      text:
        `[CLARIFICATION] ${clarification}` +
        (reason ? `\nПричина: ${reason}` : '') +
        (impact ? `\nВлияние на решение: ${impact}` : '') +
        (request.planChanged ? '\nПлан требует пересборки: агент обязан приложить новую версию плана.' : ''),
      kind: 'clarification',
      createdAt: now,
    });

    const questionsInput = (request.questions ?? []).map((question) => question.trim()).filter(Boolean);
    const questions = questionsInput.map((text) =>
      this.repos.questions.add({
        taskId: task.id,
        text,
        phase: request.phase ?? 'implementation',
        askedBy: request.actor === 'user' ? 'User' : 'AI Agent',
        createdAt: now,
      }),
    );

    if (questions.length > 0 && task.status !== 'questions') {
      this.repos.tasks.update(task.id, { status: 'questions', updatedAt: now });
    }

    const event = this.recordEvent(
      task.id,
      'clarification',
      request.actor ?? 'user',
      clarification.slice(0, 200),
      {
        clarification,
        reason,
        impact,
        planChanged: request.planChanged ?? false,
        commentId: comment.id,
        questionIds: questions.map((question) => question.id),
      },
    );
    this.reindex(task.id);

    return { task: this.getTaskCard(task.id), event, questions };
  }

  // ------------------------------------------------------------------ связи

  public linkTasks(id: string, linkedTaskId: string, relation: LinkRelation, actor: Actor = 'agent'): TaskCard {
    const task = this.requireTask(id);
    if (id === linkedTaskId) throw new TrackerError('VALIDATION_FAILED', 'Нельзя связать задачу с самой собой.');
    if (!this.repos.tasks.exists(linkedTaskId)) {
      throw new TrackerError('TASK_NOT_FOUND', `Связанная задача ${linkedTaskId} не найдена.`, { linkedTaskId });
    }

    this.repos.links.add({ taskId: id, linkedTaskId, relation, createdAt: this.clock.now() });
    this.recordEvent(task.id, 'link_added', actor, `Связь ${relation} → ${linkedTaskId}.`, { linkedTaskId, relation });
    return this.getTaskCard(id);
  }

  public unlinkTasks(id: string, linkedTaskId: string, relation?: LinkRelation, actor: Actor = 'agent'): TaskCard {
    const task = this.requireTask(id);
    const removed = this.repos.links.remove(id, linkedTaskId, relation);
    if (removed === 0) {
      throw new TrackerError('LINK_NOT_FOUND', `Связь ${id} → ${linkedTaskId} не найдена.`, { linkedTaskId, relation });
    }
    this.recordEvent(task.id, 'link_removed', actor, `Связь → ${linkedTaskId} удалена.`, {
      linkedTaskId,
      relation: relation ?? null,
    });
    return this.getTaskCard(id);
  }

  public deleteTask(id: string, actor: Actor = 'user'): boolean {
    const task = this.requireTask(id);
    this.repos.search.removeTask(id);
    const deleted = this.repos.tasks.delete(task.id);
    this.logger?.info('Задача удалена', { id, actor });
    return deleted;
  }

  public claimNextTask(preferredType?: TaskType, actor: Actor = 'agent'): TaskCard | null {
    const candidates: readonly TaskStatus[] = ['ready', 'backlog'];
    for (const status of candidates) {
      const summaries = this.repos.taskQueries.listSummaries({ status });
      const ordered = preferredType
        ? [...summaries].sort((a, b) => Number(b.type === preferredType) - Number(a.type === preferredType))
        : summaries;
      const next = ordered[0];
      if (!next) continue;
      return this.setStatus({
        id: next.id,
        status: status === 'ready' ? 'in_progress' : 'planning',
        comment: 'Задача взята в работу агентом.',
        actor,
      });
    }
    return null;
  }

  // ------------------------------------------------------------- внутреннее

  public requireTask(id: string): Task {
    const task = this.repos.tasks.findById(id);
    if (!task) throw new TrackerError('TASK_NOT_FOUND', `Задача ${id} не найдена.`, { id });
    return task;
  }

  public recordEvent(
    taskId: string,
    type: TaskEvent['type'],
    actor: Actor,
    summary: string,
    payload: Record<string, unknown> = {},
  ): TaskEvent {
    return this.repos.events.add({ taskId, type, actor, summary, payload, createdAt: this.clock.now() });
  }

  private reindex(taskId: string): void {
    if (!this.searchIndexing) return;
    this.repos.search.reindexTask(taskId);
  }

  private applyTagNames(taskId: string, names: readonly string[]): Tag[] {
    const now = this.clock.now();
    const normalized = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];
    const tags = normalized.map((name) => this.repos.tags.upsert(name, '', '', now));
    this.repos.tags.replaceTaskTags(
      taskId,
      tags.map((tag) => tag.id),
    );
    return tags;
  }

  private isDescendant(candidateParentId: string, taskId: string): boolean {
    let current: string | null = candidateParentId;
    const guard = new Set<string>();
    while (current) {
      if (guard.has(current)) return true;
      guard.add(current);
      const parent: string | null = this.repos.tasks.findById(current)?.parentId ?? null;
      if (parent === taskId) return true;
      current = parent;
    }
    return false;
  }

  private computePosition(taskId: string, status: TaskStatus, request: MoveTaskRequest): number {
    const neighbours = this.repos.tasks.listPositionsInStatus(status).filter((entry) => entry.id !== taskId);

    const beforeIndex = request.beforeId ? neighbours.findIndex((entry) => entry.id === request.beforeId) : -1;
    const afterIndex = request.afterId ? neighbours.findIndex((entry) => entry.id === request.afterId) : -1;

    if (beforeIndex >= 0) {
      const before = neighbours[beforeIndex].position;
      const previous = beforeIndex > 0 ? neighbours[beforeIndex - 1].position : before - POSITION_STEP * 2;
      return (previous + before) / 2;
    }
    if (afterIndex >= 0) {
      const after = neighbours[afterIndex].position;
      const next = afterIndex + 1 < neighbours.length ? neighbours[afterIndex + 1].position : after + POSITION_STEP * 2;
      return (after + next) / 2;
    }
    if (request.toIndex !== undefined && request.toIndex >= 0) {
      const index = Math.min(request.toIndex, neighbours.length);
      if (index === 0) {
        const first = neighbours[0];
        return first ? first.position - POSITION_STEP : POSITION_STEP;
      }
      const previous = neighbours[index - 1];
      const next = neighbours[index];
      if (!previous) return POSITION_STEP;
      if (!next) return previous.position + POSITION_STEP;
      return (previous.position + next.position) / 2;
    }

    const last = neighbours[neighbours.length - 1];
    return last ? last.position + POSITION_STEP : POSITION_STEP;
  }
}

/** Формат метки времени для блока «Дополнительные требования пользователя». */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
