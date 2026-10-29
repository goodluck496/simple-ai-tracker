import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppContainer } from '../bootstrap/container.js';
import { TrackerError, isTrackerError } from '../core/errors.js';
import { TASK_STATUSES, assertTaskStatus } from '../domain/task-status.js';
import { TASK_TYPES, isTaskType } from '../domain/task-type.js';
import { LINK_RELATIONS, QUESTION_PHASES, SEARCH_SCOPES, type LinkRelation, type QuestionPhase } from '../domain/entities.js';
import type { SearchScope, TaskFilters } from '../domain/entities.js';
import type { AgentOutcome } from '../../../shared/automation/contracts.js';
import { AutomationTool, AUTOMATION_TOOLS, AUTOMATION_TOOL_PREFIX } from '../../../shared/automation/protocol.js';
import { BATCH_TASK_LIMIT } from '../../../shared/automation/batch.js';
import { AGENT_TRACKER_READ_TOOLS } from '../../../shared/automation/tracker-access.js';
import type { RunPhase } from '../../../shared/automation/queue.js';

export interface McpToolDefinition {
  readonly annotations?: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export interface McpTextResult extends CallToolResult {}

type Args = Record<string, unknown>;

const STATUS_ENUM = [...TASK_STATUSES];
const TYPE_ENUM = [...TASK_TYPES];

function text(value: string, isError = false): McpTextResult {
  return isError ? { content: [{ type: 'text', text: value }], isError: true } : { content: [{ type: 'text', text: value }] };
}

function json(value: unknown): McpTextResult {
  return text(JSON.stringify(value, null, 2));
}

function asString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asStringArray(args: Args, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0);
}

function asBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function requireString(args: Args, key: string): string {
  const value = asString(args, key);
  if (!value) throw new TrackerError('VALIDATION_FAILED', `Параметр "${key}" обязателен.`);
  return value;
}

/**
 * MCP-инструменты Simple AI Tracker.
 * Все чтения и записи карточек идут через доменный TaskService — транспорт
 * не содержит правил жизненного цикла.
 */
export class TrackerToolRegistry {
  private readonly workspace: string;
  public constructor(private readonly app: AppContainer) {
    this.workspace = process.env.SAT_WORKSPACE ?? 'default';
  }

  public definitions(): McpToolDefinition[] {
    return [
      ...AUTOMATION_TOOLS.map((name): McpToolDefinition => ({
        name, description: `Automation ${name}. Operates only in the selected workspace. Worker mutations require an active leaseToken.`,
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, taskId: { type: 'string' }, taskIds: { type: 'array', items: { type: 'string' }, maxItems: BATCH_TASK_LIMIT }, requestId: { type: 'string' }, workerId: { type: 'string' },
          leaseToken: { type: 'string' }, text: { type: 'string' }, branch: { type: 'string' }, commitSha: { type: 'string' },
          attemptId: { type: 'string' }, usage: { type: 'object', additionalProperties: true }, finished: { type: 'boolean' },
          settings: { type: 'object', additionalProperties: true }, outcome: { type: 'object', additionalProperties: true },
          result: { type: 'object', additionalProperties: true }, error: { type: 'string' }, platform: { type: 'string' }, phase: { type: 'string' } } },
      })),
      { name: 'tracker_list_workspaces', description: 'List project workspaces and the workspace pinned to this MCP session.',
        inputSchema: { type: 'object', properties: {} } },
      {
        name: 'tracker_get_instructions',
        description:
          'Возвращает обязательную инструкцию по работе с трекером (порядок работы 1–9, запрет grep/файлов, правила уточнений). Вызывай, если потерял контекст или сомневаешься в регламенте.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tracker_get_task',
        description:
          'ОБЯЗАТЕЛЬНЫЙ первый вызов при работе с задачей. Возвращает контекст-пак: описание, тип, статус, теги, связи (родитель/подзадачи/links), текущий план и историю версий, открытые и отвеченные вопросы, журнал решений (уточнения, смены статусов), комментарии и подсказки nextActions.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID задачи, например SAT-12' },
            commentsLimit: { type: 'number', description: 'Сколько последних комментариев вернуть (по умолчанию все)' },
          },
          required: ['id'],
        },
      },
      {
        name: 'tracker_list_tasks',
        description: 'Список задач с фильтрами. Возвращает компактные карточки: id, title, type, status, tags, счётчики.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: STATUS_ENUM, description: 'Фильтр по статусу' },
            type: { type: 'string', enum: TYPE_ENUM, description: 'Фильтр по типу' },
            tag: { type: 'string', description: 'Фильтр по тегу' },
            parentId: { type: 'string', description: 'Фильтр по родительской задаче' },
            query: { type: 'string', description: 'Текстовый поиск по названию/описанию/комментариям/тегам/ID' },
            limit: { type: 'number', description: 'Максимум записей (по умолчанию 100)' },
          },
        },
      },
      {
        name: 'tracker_search_tasks',
        description: 'Полнотекстовый поиск задач (SQLite FTS5) по заголовку, описанию, комментариям, тегам или ID.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковая фраза' },
            scope: {
              anyOf: [
                { type: 'string', enum: [...SEARCH_SCOPES] },
                { type: 'array', items: { type: 'string', enum: [...SEARCH_SCOPES] } },
              ],
              description: 'Область поиска: одна строка или список (по умолчанию all)',
            },
            status: { type: 'string', enum: STATUS_ENUM },
            type: { type: 'string', enum: TYPE_ENUM },
            tag: { type: 'string' },
            parentId: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'tracker_get_next_task',
        description:
          'Берёт следующую готовую задачу (сначала ready → in_progress, затем backlog → planning) и возвращает её контекст-пак.',
        inputSchema: {
          type: 'object',
          properties: {
            preferredType: { type: 'string', enum: TYPE_ENUM, description: 'Предпочитаемый тип задачи' },
          },
        },
      },
      {
        name: 'tracker_create_task',
        description: 'Создаёт фичу, задачу или баг. Возвращает контекст-пак созданной карточки.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Название' },
            type: { type: 'string', enum: TYPE_ENUM, description: 'Тип (по умолчанию task)' },
            description: { type: 'string', description: 'Описание, критерии приёмки' },
            status: { type: 'string', enum: STATUS_ENUM, description: 'Начальный статус (по умолчанию backlog)' },
            parentId: { type: 'string', description: 'ID родительской фичи' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги' },
            requiresManualTesting: { type: 'boolean', description: 'Требуется ручная проверка пользователем' },
            relatedTaskIds: { type: 'array', items: { type: 'string' }, description: 'ID связанных задач' },
            initialComment: { type: 'string', description: 'Начальный комментарий' },
          },
          required: ['title'],
        },
      },
      {
        name: 'tracker_update_task',
        description: 'Обновляет название, описание, тип, теги или флаг ручного тестирования карточки.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            type: { type: 'string', enum: TYPE_ENUM },
            tags: { type: 'array', items: { type: 'string' }, description: 'Полный новый список тегов' },
            addTags: { type: 'array', items: { type: 'string' } },
            removeTags: { type: 'array', items: { type: 'string' } },
            requiresManualTesting: { type: 'boolean' },
            parentId: { type: 'string' },
          },
          required: ['id'],
        },
      },
      {
        name: 'tracker_set_status',
        description:
          'Меняет статус карточки с проверкой допустимости перехода. Статус done агенту недоступен — его ставит только пользователь.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: STATUS_ENUM },
            comment: { type: 'string', description: 'Комментарий в историю (что сделано/почему)' },
          },
          required: ['id', 'status'],
        },
      },
      {
        name: 'tracker_add_comment',
        description: 'Добавляет комментарий в карточку: ход работы, решения, результаты, ссылки на файлы.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            author: { type: 'string', description: 'Автор (по умолчанию "AI Agent")' },
            kind: {
              type: 'string',
              enum: ['note', 'status', 'requirement', 'clarification', 'plan', 'test-report', 'system'],
            },
          },
          required: ['id', 'text'],
        },
      },
      {
        name: 'tracker_ask_questions',
        description:
          'Задаёт вопросы пользователю в карточке и переводит её в статус questions. Единственный разрешённый способ задать вопрос — не в чате.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            questions: { type: 'array', items: { type: 'string' }, description: 'Список вопросов' },
            phase: { type: 'string', enum: [...QUESTION_PHASES], description: 'Фаза: planning/implementation/testing' },
          },
          required: ['id', 'questions'],
        },
      },
      {
        name: 'tracker_answer_questions',
        description:
          'Записывает в карточку ответы пользователя, полученные в чате (в UI ответы сохраняются сами). Когда открытых вопросов не остаётся, карточка переходит в ready (если план есть) или planning.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            answers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  questionId: { type: 'number' },
                  questionIndex: { type: 'number' },
                  answer: { type: 'string' },
                },
                required: ['answer'],
              },
              description: 'Ответы: укажи questionId (из tracker_get_task) или questionIndex',
            },
            answeredBy: { type: 'string', description: 'Кто ответил (по умолчанию "User")' },
          },
          required: ['id', 'answers'],
        },
      },
      {
        name: 'tracker_attach_plan',
        description:
          'Прикрепляет план реализации (markdown) с автоинкрементом версии. Без вопросов переводит карточку в ready; с вопросами — в questions. История планов сохраняется.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            planContent: { type: 'string', description: 'Текст плана (markdown)' },
            planPath: { type: 'string', description: 'Путь к файлу плана в проекте (если план лежит файлом)' },
            fileName: { type: 'string', description: 'Имя вложения (по умолчанию plan-<id>.md)' },
            summary: { type: 'string', description: 'Краткое резюме плана (1–3 предложения)' },
            questions: { type: 'array', items: { type: 'string' }, description: 'Уточняющие вопросы пользователю' },
            phase: { type: 'string', enum: [...QUESTION_PHASES] },
            statusMode: {
              type: 'string',
              enum: ['auto', 'none'],
              description: 'auto (по умолчанию) — сменить статус, none — только приложить план',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'tracker_record_clarification',
        description:
          'Фиксирует уточнение пользователя по ходу работы: пишет его в описание, комментарий [CLARIFICATION] и журнал решений, чтобы след «что просили → что уточнили → что изменилось» сохранился. При questions карточка уходит в questions.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            clarification: { type: 'string', description: 'Что именно уточнил пользователь (его формулировка)' },
            reason: { type: 'string', description: 'Зачем и почему' },
            impact: { type: 'string', description: 'Как это меняет прежнее решение' },
            planChanged: { type: 'boolean', description: 'true, если план нужно пересобрать' },
            questions: { type: 'array', items: { type: 'string' }, description: 'Новые вопросы пользователю' },
            phase: { type: 'string', enum: [...QUESTION_PHASES] },
          },
          required: ['id', 'clarification'],
        },
      },
      {
        name: 'tracker_add_attachment',
        description: 'Прикладывает файл к карточке: отчёт о тестах (kind="report"), результаты, прочие документы.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string', description: 'Имя файла, например test-report.md' },
            content: { type: 'string', description: 'Содержимое (markdown/текст)' },
            kind: { type: 'string', enum: ['report', 'file'], description: 'Тип вложения (по умолчанию file)' },
          },
          required: ['id', 'name', 'content'],
        },
      },
      {
        name: 'tracker_link_tasks',
        description: 'Создаёт связь между карточками: related, blocks, blocked_by, duplicates, duplicated_by.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            linkedTaskId: { type: 'string' },
            relation: { type: 'string', enum: [...LINK_RELATIONS], description: 'Тип связи (по умолчанию related)' },
          },
          required: ['id', 'linkedTaskId'],
        },
      },
      {
        name: 'tracker_unlink_tasks',
        description: 'Удаляет связь между карточками.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            linkedTaskId: { type: 'string' },
            relation: { type: 'string', enum: [...LINK_RELATIONS] },
          },
          required: ['id', 'linkedTaskId'],
        },
      },
      {
        name: 'tracker_list_tags',
        description: 'Реестр тегов с количеством задач по каждому тегу.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tracker_add_tag',
        description: 'Создаёт тег и/или привязывает его к карточке.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            color: { type: 'string', description: 'HEX-цвет, например #38bdf8' },
            description: { type: 'string' },
            taskId: { type: 'string', description: 'ID задачи, к которой добавить тег' },
          },
          required: ['name'],
        },
      },
      {
        name: 'tracker_verify_task',
        description:
          'Компактная проверка целостности карточки (кодировка, план, вопросы, статус, связи). Заменяет git diff/grep по данным задач.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    ].map((definition) => ({ ...definition,
      annotations: (AGENT_TRACKER_READ_TOOLS as readonly string[]).includes(definition.name)
        ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false } : { readOnlyHint: false },
      inputSchema: { ...definition.inputSchema,
      properties: { ...definition.inputSchema.properties, workspace: { type: 'string', description: 'Explicit project workspace. Defaults to SAT_WORKSPACE or default.' } } } })) as McpToolDefinition[];
  }

  public async call(name: string, args: Args): Promise<McpTextResult> {
    try {
      if (name === 'tracker_list_workspaces') return json({ workspaces: this.app.workspaceManager.list(), current: this.workspace });
      return this.app.workspaceManager.within(asString(args, 'workspace') ?? this.workspace, () => this.dispatch(name, args));
    } catch (error) {
      if (isTrackerError(error)) {
        return text(`Ошибка (${error.code}): ${error.message}`, true);
      }
      return text(`Внутренняя ошибка: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private dispatch(name: string, args: Args): McpTextResult {
    if (name.startsWith(AUTOMATION_TOOL_PREFIX)) {
      const service = this.app.automationService;
      const id = () => requireString(args, 'id');
      const token = () => requireString(args, 'leaseToken');
      switch (name) {
        case AutomationTool.Configure: return json(service.configure(args['settings']));
        case AutomationTool.Settings: return json(service.settings());
        case AutomationTool.TaskTeam: return json(service.taskTeam(requireString(args, 'taskId'), args['phase'] === 'reset' ? null : args['settings']));
        case AutomationTool.HostStatus: return json(service.projects.status());
        case AutomationTool.WorkerStart: return json(service.projects.enqueue({ action: 'start-worker', path: '' }));
        case AutomationTool.WorkerStop: return json(service.projects.enqueue({ action: 'stop-worker', path: '' }));
        case AutomationTool.HostPoll: return json(service.projects.poll(requireString(args, 'workerId'), asString(args, 'platform'), (args['result'] as { execution?: import('../../../shared/automation/project.js').ExecutionStatus } | undefined)?.execution));
        case AutomationTool.HostComplete: service.completeHost(id(), token(), args['result'] as import('../../../shared/automation/project.js').ProjectResult | undefined, asString(args, 'error')); return json({ ok: true });
        case AutomationTool.ListRuns: return json(service.list(asString(args, 'taskId')));
        case AutomationTool.GetRun: return json(service.detail(id()));
        case AutomationTool.History: return json(service.queue(true, asString(args, 'taskId')));
        case AutomationTool.Archive: service.hide(id()); return json({ ok: true });
        case AutomationTool.Cleanup: return json(service.cleanup(id(), (args['result'] as { discard?: boolean } | undefined)?.discard === true));
        case AutomationTool.Delete: service.deleteRun(id()); return json({ ok: true });
        case AutomationTool.Enqueue: return json(service.enqueue(requireString(args, 'taskId'), args['settings'], false));
        case AutomationTool.EnqueueBatch: return json({ runs: service.enqueueBatch(args['taskIds'], args['settings'], args['requestId']) });
        case AutomationTool.ExtendBudget: return json(service.extendBudget(id(), args['settings']));
        case AutomationTool.Claim: return json(service.claim(requireString(args, 'workerId')));
        case AutomationTool.Heartbeat: return json(service.heartbeat(id(), token(), args['phase'] === 'recovery', args['phase'] === 'publish'));
        case AutomationTool.Progress: service.progress(id(), token(), requireString(args, 'text'), asString(args, 'phase') as RunPhase | undefined); return json({ ok: true });
        case AutomationTool.BeginStage: return json({ ok: true, attemptId: service.beginStage(id(), token(), args['phase'] === 'resolver') });
        case AutomationTool.Checkout: service.checkout(id(), token(), args['result']); return json({ ok: true });
        case AutomationTool.Integration: service.integration(id(), token(), args['result']); return json({ ok: true });
        case AutomationTool.Usage: service.usage(id(), token(), requireString(args, 'attemptId'), args['usage'], args['finished'] === true); return json({ ok: true });
        case AutomationTool.Checkpoint: return json(service.checkpoint(id(), token(), requireString(args, 'attemptId'), args['result']));
        case AutomationTool.CompleteStage: return json(service.completeStage(id(), token(), args['outcome'] as AgentOutcome, requireString(args, 'branch'), requireString(args, 'commitSha')));
        case AutomationTool.Fail: service.fail(id(), token(), requireString(args, 'text')); return json({ ok: true });
        case AutomationTool.Cancel: service.cancel(id()); return json({ ok: true });
        case AutomationTool.Resume: return json(service.resume(id()));
        case AutomationTool.Merged: service.merged(id(), token()); return json({ ok: true });
      }
    }
    const { taskService, contextService, tagService, verificationService, instructionsService } = this.app;

    switch (name) {
      case 'tracker_get_instructions':
        return text(instructionsService.get());

      case 'tracker_get_task': {
        const pack = contextService.build(requireString(args, 'id'));
        const limit = asNumber(args, 'commentsLimit');
        if (limit && limit > 0) {
          return json({ ...pack, comments: pack.comments.slice(-Math.trunc(limit)) });
        }
        return json(pack);
      }

      case 'tracker_list_tasks': {
        const filters: TaskFilters = {
          status: asString(args, 'status') ? assertTaskStatus(args['status']) : undefined,
          type: asString(args, 'type') && isTaskType(args['type']) ? (args['type'] as never) : undefined,
          tag: asString(args, 'tag'),
          parentId: asString(args, 'parentId'),
          query: asString(args, 'query'),
          limit: asNumber(args, 'limit') ?? 100,
        };
        return json(compactList(taskService.listTasks(filters)));
      }

      case 'tracker_search_tasks': {
        const rawScope = args['scope'];
        const scopes: SearchScope[] = Array.isArray(rawScope)
          ? rawScope.map((value) => String(value)).filter((value): value is SearchScope =>
              (SEARCH_SCOPES as readonly string[]).includes(value),
            )
          : asString(args, 'scope')
            ? [asString(args, 'scope') as SearchScope]
            : ['all'];

        const filters: TaskFilters = {
          query: requireString(args, 'query'),
          scopes,
          status: asString(args, 'status') ? assertTaskStatus(args['status']) : undefined,
          type: asString(args, 'type') && isTaskType(args['type']) ? (args['type'] as never) : undefined,
          tag: asString(args, 'tag'),
          parentId: asString(args, 'parentId'),
          limit: asNumber(args, 'limit') ?? 50,
        };
        return json(compactList(taskService.searchTasks(filters)));
      }

      case 'tracker_get_next_task': {
        const preferred = asString(args, 'preferredType');
        const card = taskService.claimNextTask(
          preferred && isTaskType(preferred) ? (preferred as never) : undefined,
          'agent',
        );
        if (!card) return text('Нет задач в статусе ready или backlog.');
        return json({ claimed: card.id, status: card.status, context: contextService.build(card.id) });
      }

      case 'tracker_create_task': {
        const card = taskService.createTask({
          title: requireString(args, 'title'),
          type: asString(args, 'type') && isTaskType(args['type']) ? (args['type'] as never) : 'task',
          description: asString(args, 'description') ?? '',
          status: asString(args, 'status') ? assertTaskStatus(args['status']) : 'backlog',
          parentId: asString(args, 'parentId') ?? null,
          tags: asStringArray(args, 'tags'),
          requiresManualTest: asBoolean(args, 'requiresManualTesting') ?? false,
          relatedTaskIds: asStringArray(args, 'relatedTaskIds'),
          initialComment: asString(args, 'initialComment'),
          actor: 'agent',
        });
        return json({ created: card.id, context: contextService.build(card.id) });
      }

      case 'tracker_update_task': {
        const card = taskService.updateTask({
          id: requireString(args, 'id'),
          title: asString(args, 'title'),
          description: typeof args['description'] === 'string' ? String(args['description']) : undefined,
          type: asString(args, 'type') && isTaskType(args['type']) ? (args['type'] as never) : undefined,
          tags: Array.isArray(args['tags']) ? asStringArray(args, 'tags') : undefined,
          addTags: Array.isArray(args['addTags']) ? asStringArray(args, 'addTags') : undefined,
          removeTags: Array.isArray(args['removeTags']) ? asStringArray(args, 'removeTags') : undefined,
          requiresManualTest: asBoolean(args, 'requiresManualTesting'),
          parentId: typeof args['parentId'] === 'string' ? args['parentId'] : undefined,
          actor: 'agent',
        });
        return text(
          `Карточка ${card.id} обновлена. Статус: ${card.status}. Теги: ${card.tags.map((tag) => tag.name).join(', ') || '—'}.`,
        );
      }

      case 'tracker_set_status': {
        const card = taskService.setStatus({
          id: requireString(args, 'id'),
          status: assertTaskStatus(args['status']),
          comment: asString(args, 'comment'),
          actor: 'agent',
        });
        return text(
          `Статус ${card.id}: ${card.status}.${card.openQuestionsCount > 0 ? ` Открытых вопросов: ${card.openQuestionsCount}.` : ''}`,
        );
      }

      case 'tracker_add_comment': {
        const comment = taskService.addComment({
          id: requireString(args, 'id'),
          text: requireString(args, 'text'),
          author: asString(args, 'author') ?? 'AI Agent',
          kind: (asString(args, 'kind') as never) ?? 'note',
          actor: 'agent',
        });
        return text(`Комментарий добавлен в ${comment.taskId} (id ${comment.id}).`);
      }

      case 'tracker_ask_questions': {
        const phase = asString(args, 'phase');
        const result = taskService.askQuestions({
          id: requireString(args, 'id'),
          questions: asStringArray(args, 'questions'),
          phase: (phase as QuestionPhase | undefined) ?? undefined,
          actor: 'agent',
        });
        return json({
          task: result.task.id,
          status: result.task.status,
          questions: result.questions.map((question) => ({ id: question.id, text: question.text })),
          notification:
            'Сообщи пользователю: вопросы опубликованы в карточке, работа ждёт ответов. Вопросы в чат не дублируй.',
        });
      }

      case 'tracker_answer_questions': {
        const rawAnswers = Array.isArray(args['answers']) ? args['answers'] : [];
        const answers = rawAnswers.map((entry) => {
          const record = (entry ?? {}) as Record<string, unknown>;
          return {
            questionId: typeof record['questionId'] === 'number' ? record['questionId'] : undefined,
            questionIndex: typeof record['questionIndex'] === 'number' ? record['questionIndex'] : undefined,
            answer: String(record['answer'] ?? ''),
          };
        });
        const result = taskService.answerQuestions({
          id: requireString(args, 'id'),
          answers,
          answeredBy: asString(args, 'answeredBy') ?? 'User',
          actor: 'agent',
        });
        return json({
          task: result.task.id,
          status: result.task.status,
          answered: result.answered.length,
          openQuestions: result.task.openQuestionsCount,
        });
      }

      case 'tracker_attach_plan': {
        const planContent = this.resolvePlanContent(args);
        const statusMode = asString(args, 'statusMode');
        const phase = asString(args, 'phase');
        const result = taskService.attachPlan({
          id: requireString(args, 'id'),
          planContent,
          planPath: asString(args, 'planPath'),
          fileName: asString(args, 'fileName'),
          summary: asString(args, 'summary'),
          questions: asStringArray(args, 'questions'),
          phase: (phase as QuestionPhase | undefined) ?? undefined,
          statusMode: statusMode === 'none' ? 'none' : 'auto',
          actor: 'agent',
        });
        return json({
          task: result.task.id,
          planVersion: result.plan.version,
          planName: result.plan.name,
          planSize: result.plan.size,
          status: result.task.status,
          questions: result.questions.map((question) => ({ id: question.id, text: question.text })),
          planHistory: result.task.planHistory.map((revision) => revision.version),
        });
      }

      case 'tracker_record_clarification': {
        const phase = asString(args, 'phase');
        const result = taskService.recordClarification({
          id: requireString(args, 'id'),
          clarification: requireString(args, 'clarification'),
          reason: asString(args, 'reason'),
          impact: asString(args, 'impact'),
          planChanged: asBoolean(args, 'planChanged'),
          questions: asStringArray(args, 'questions'),
          phase: (phase as QuestionPhase | undefined) ?? undefined,
          actor: 'user',
        });
        return json({
          task: result.task.id,
          status: result.task.status,
          eventId: result.event.id,
          planVersion: result.task.plan?.version ?? null,
          questions: result.questions.map((question) => ({ id: question.id, text: question.text })),
          reminder: result.questions.length
            ? 'Вопросы заданы: работа останавливается до ответов пользователя.'
            : 'Уточнение зафиксировано. Перечитай план и при необходимости приложи новую версию через tracker_attach_plan.',
        });
      }

      case 'tracker_add_attachment': {
        const kind = asString(args, 'kind');
        const attachment = taskService.addAttachment(
          requireString(args, 'id'),
          {
            name: requireString(args, 'name'),
            content: requireString(args, 'content'),
            kind: kind === 'report' ? 'report' : 'file',
          },
          'agent',
        );
        return text(`Вложение «${attachment.name}» (${attachment.kind}, ${attachment.size} байт) добавлено в ${attachment.taskId}.`);
      }

      case 'tracker_link_tasks': {
        const relation = (asString(args, 'relation') as LinkRelation | undefined) ?? 'related';
        const card = taskService.linkTasks(requireString(args, 'id'), requireString(args, 'linkedTaskId'), relation, 'agent');
        return text(`Связь ${relation} создана: ${card.id} → ${String(args['linkedTaskId'])}.`);
      }

      case 'tracker_unlink_tasks': {
        const relation = asString(args, 'relation') as LinkRelation | undefined;
        const card = taskService.unlinkTasks(
          requireString(args, 'id'),
          requireString(args, 'linkedTaskId'),
          relation,
          'agent',
        );
        return text(`Связь удалена у ${card.id}.`);
      }

      case 'tracker_list_tags':
        return json({ tags: tagService.list() });

      case 'tracker_add_tag': {
        const tag = tagService.add({
          name: requireString(args, 'name'),
          color: asString(args, 'color'),
          description: asString(args, 'description'),
        });
        const taskId = asString(args, 'taskId');
        if (taskId) {
          taskService.updateTask({ id: taskId, addTags: [tag.name], actor: 'agent' });
        }
        return text(`Тег «${tag.name}» сохранён${taskId ? ` и привязан к ${taskId}` : ''}.`);
      }

      case 'tracker_verify_task':
        return json(verificationService.verify(requireString(args, 'id')));

      default:
        return text(`Неизвестный инструмент: ${name}`, true);
    }
  }

  private resolvePlanContent(args: Args): string {
    const inline = asString(args, 'planContent');
    if (inline) return inline;
    const planPath = asString(args, 'planPath');
    if (!planPath) {
      throw new TrackerError('VALIDATION_FAILED', 'Передай planContent (текст плана) или planPath (файл плана).');
    }
    const candidates = [path.resolve(process.cwd(), planPath), path.resolve(this.app.config.appRoot, planPath)];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new TrackerError('VALIDATION_FAILED', `Файл плана не найден: ${planPath}`, { candidates });
    }
    return fs.readFileSync(found, 'utf8');
  }
}

/** Компактное представление списка задач (экономия контекста LLM). */
function compactList(
  summaries: readonly {
    id: string;
    title: string;
    type: string;
    status: string;
    parentId: string | null;
    tags: readonly { name: string }[];
    openQuestionsCount: number;
    hasPlan: boolean;
    currentPlanVersion: number | null;
    requiresManualTest: boolean;
  }[],
): unknown {
  return summaries.map((summary) => ({
    id: summary.id,
    title: summary.title,
    type: summary.type,
    status: summary.status,
    parentId: summary.parentId,
    tags: summary.tags.map((tag) => tag.name),
    openQuestions: summary.openQuestionsCount,
    plan: summary.hasPlan ? `v${summary.currentPlanVersion}` : null,
    manualTest: summary.requiresManualTest,
  }));
}
