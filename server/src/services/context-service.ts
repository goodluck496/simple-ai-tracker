import type { TaskService } from './task-service.js';
import type { PlanRevision, TaskComment, TaskSummary } from '../domain/entities.js';
import { canTransition, STATUS_META, TASK_STATUSES, USER_ONLY_STATUSES, type TaskStatus } from '../domain/task-status.js';
import { TASK_TYPE_META } from '../domain/task-type.js';

export interface ContextQuestion {
  readonly id: number;
  readonly text: string;
  readonly phase: string;
  readonly createdAt: string;
}

export interface ContextAnswer {
  readonly id: number;
  readonly question: string;
  readonly answer: string;
  readonly answeredAt: string | null;
}

export interface ContextDecision {
  readonly at: string;
  readonly type: string;
  readonly actor: string;
  readonly summary: string;
  readonly details: Record<string, unknown>;
}

export interface ContextRelation {
  readonly relation: string;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly status: string;
  };
}

export interface AgentContextPack {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
  readonly type: string;
  readonly typeTitle: string;
  readonly status: TaskStatus;
  readonly statusTitle: string;
  readonly requiresManualTest: boolean;
  readonly parentId: string | null;
  readonly description: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workflow: {
    readonly guidance: string;
    readonly allowedNextStatuses: readonly TaskStatus[];
    readonly userOnlyStatuses: readonly TaskStatus[];
    readonly statusLegend: readonly { status: TaskStatus; title: string; hint: string }[];
  };
  readonly plan: {
    readonly version: number;
    readonly name: string;
    readonly sourcePath: string | null;
    readonly createdAt: string;
    readonly content: string;
  } | null;
  readonly planHistory: readonly PlanRevision[];
  readonly questions: {
    readonly open: readonly ContextQuestion[];
    readonly answered: readonly ContextAnswer[];
  };
  readonly decisionLog: readonly ContextDecision[];
  readonly relations: {
    readonly parent: TaskSummary | null;
    readonly subtasks: readonly TaskSummary[];
    readonly links: readonly ContextRelation[];
  };
  readonly comments: readonly Pick<TaskComment, 'author' | 'text' | 'kind' | 'createdAt'>[];
  readonly attachments: readonly { name: string; kind: string; version: number; size: number; createdAt: string }[];
  readonly imagesCount: number;
  readonly nextActions: readonly string[];
}

const DECISION_EVENT_TYPES = new Set([
  'clarification',
  'plan_attached',
  'status_changed',
  'question_asked',
  'question_answered',
  'link_added',
]);

/**
 * Собирает «контекст-пак» карточки для агента: всё, что нужно, чтобы понять
 * задачу, её связи, историю решений и текущее место в процессе — одним вызовом.
 */
export class ContextService {
  public constructor(private readonly taskService: TaskService) {}

  public build(taskId: string): AgentContextPack {
    const card = this.taskService.getTaskCard(taskId);

    const openQuestions: ContextQuestion[] = card.questions
      .filter((question) => question.isOpen)
      .map((question) => ({
        id: question.id,
        text: question.text,
        phase: question.phase,
        createdAt: question.createdAt,
      }));

    const answeredQuestions: ContextAnswer[] = card.questions
      .filter((question) => !question.isOpen)
      .map((question) => ({
        id: question.id,
        question: question.text,
        answer: question.answer ?? '',
        answeredAt: question.answeredAt,
      }));

    const decisionLog: ContextDecision[] = card.events
      .filter((event) => DECISION_EVENT_TYPES.has(event.type))
      .map((event) => ({
        at: event.createdAt,
        type: event.type,
        actor: event.actor,
        summary: event.summary,
        details: event.payload,
      }));

    const links: ContextRelation[] = [];
    const seenLinks = new Set<string>();
    for (const link of card.links) {
      const isOutgoing = link.taskId === card.id;
      const otherId = isOutgoing ? link.linkedTaskId : link.taskId;
      const other = this.taskService.getSummary(otherId);
      if (!other) continue;
      const relation = isOutgoing ? link.relation : invertRelation(link.relation);
      const key = `${relation}:${otherId}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      links.push({ relation, task: { id: other.id, title: other.title, type: other.type, status: other.status } });
    }

    return {
      id: card.id,
      seq: card.seq,
      title: card.title,
      type: card.type,
      typeTitle: TASK_TYPE_META[card.type].title,
      status: card.status,
      statusTitle: STATUS_META[card.status].title,
      requiresManualTest: card.requiresManualTest,
      parentId: card.parentId,
      description: card.description,
      tags: card.tags.map((tag) => tag.name),
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      workflow: {
        guidance: STATUS_META[card.status].agentGuidance,
        allowedNextStatuses: allowedNext(card.status),
        userOnlyStatuses: [...USER_ONLY_STATUSES],
        statusLegend: TASK_STATUSES.map((status) => ({
          status,
          title: STATUS_META[status].title,
          hint: STATUS_META[status].description,
        })),
      },
      plan: card.plan
        ? {
            version: card.plan.version,
            name: card.plan.name,
            sourcePath: card.plan.sourcePath,
            createdAt: card.plan.createdAt,
            content: card.plan.content,
          }
        : null,
      planHistory: card.planHistory,
      questions: { open: openQuestions, answered: answeredQuestions },
      decisionLog,
      relations: { parent: card.parent, subtasks: card.subtasks, links },
      comments: card.comments.map((comment) => ({
        author: comment.author,
        text: comment.text,
        kind: comment.kind,
        createdAt: comment.createdAt,
      })),
      attachments: card.attachments.map((attachment) => ({
        name: attachment.name,
        kind: attachment.kind,
        version: attachment.version,
        size: attachment.size,
        createdAt: attachment.createdAt,
      })),
      imagesCount: card.images.length,
      nextActions: buildNextActions(card.status, {
        hasPlan: Boolean(card.plan),
        openQuestions: openQuestions.length,
        requiresManualTest: card.requiresManualTest,
      }),
    };
  }
}

function invertRelation(relation: string): string {
  switch (relation) {
    case 'blocks':
      return 'blocked_by';
    case 'blocked_by':
      return 'blocks';
    case 'duplicates':
      return 'duplicated_by';
    case 'duplicated_by':
      return 'duplicates';
    default:
      return 'related';
  }
}

function allowedNext(status: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter(
    (candidate) => candidate !== status && !USER_ONLY_STATUSES.includes(candidate) && canTransition(status, candidate),
  );
}

function buildNextActions(
  status: TaskStatus,
  facts: { hasPlan: boolean; openQuestions: number; requiresManualTest: boolean },
): string[] {
  switch (status) {
    case 'backlog':
      return ['Переведи карточку в planning и начни исследование задачи.'];
    case 'planning':
      if (facts.openQuestions > 0) return ['В карточке есть открытые вопросы — дождись ответов пользователя.'];
      if (!facts.hasPlan) return ['Исследуй код и скилы проекта, затем приложи план через tracker_attach_plan.'];
      return ['План приложен: убедись, что вопросов нет, и переведи задачу в ready.'];
    case 'questions':
      return [
        'Ожидаются ответы пользователя. Не продолжай работу до ответов.',
        'Когда пользователь ответит в чате — зафиксируй ответы через tracker_answer_questions.',
      ];
    case 'ready':
      return ['Переведи задачу в in_progress и реализуй строго по плану.'];
    case 'in_progress':
      return [
        'Реализуй по плану. Новое уточнение → tracker_record_clarification, новый вопрос → tracker_ask_questions.',
        'После реализации переведи задачу в testing и напиши автотесты.',
      ];
    case 'testing':
      return ['Прогони тесты, приложи отчёт через tracker_add_attachment(kind="report") и переведи в review.'];
    case 'review':
      return [
        facts.requiresManualTest
          ? 'Сообщи пользователю, что карточка готова к ручной проверке. В done переводит пользователь.'
          : 'Сообщи пользователю, что автопроверки зелёные. В done переводит пользователь.',
      ];
    case 'done':
      return ['Задача закрыта пользователем. Новых действий не требуется.'];
    default:
      return [];
  }
}
