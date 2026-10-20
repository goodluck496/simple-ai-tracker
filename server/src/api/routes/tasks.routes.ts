import type { AppContainer } from '../../bootstrap/container.js';
import type { Router } from '../router.js';
import { bodyField, sendJson, requireBodyField } from '../router.js';
import { SEARCH_SCOPES } from '../../domain/entities.js';
import type { LinkRelation, QuestionPhase, SearchScope, TaskFilters } from '../../domain/entities.js';

/** Приводит вид вложения из тела запроса к допустимому значению. */
function resolveAttachmentKind(value: string | undefined): 'plan' | 'report' | 'file' {
  if (value === 'plan' || value === 'report') return value;
  return 'file';
}

/** Читает области поиска из query: ?scope=title,comments или ?scope=title&scope=tags. */
function parseScopes(query: URLSearchParams): SearchScope[] | undefined {
  const values = [...query.getAll('scope'), ...query.getAll('scopes')]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value): value is SearchScope => (SEARCH_SCOPES as readonly string[]).includes(value));
  return values.length > 0 ? values : undefined;
}
import { assertTaskStatus } from '../../domain/task-status.js';
import { assertTaskType, isTaskType } from '../../domain/task-type.js';

/**
 * REST API карточек.
 * UI выступает как пользователь (actor = 'user'), поэтому может закрывать
 * задачи в done; агент работает через MCP и такого права не имеет.
 */
export function registerTaskRoutes(router: Router, app: AppContainer): void {
  const { taskService, contextService } = app;

  router.get('/api/tasks', ({ query, res }) => {
    const filters: TaskFilters = {
      status: query.get('status') ? assertTaskStatus(query.get('status')) : undefined,
      type: query.get('type') && isTaskType(query.get('type')) ? assertTaskType(query.get('type')) : undefined,
      tag: query.get('tag') ?? undefined,
      parentId: query.get('parentId') ?? undefined,
      query: query.get('q') ?? query.get('query') ?? undefined,
      scopes: parseScopes(query),
      limit: query.get('limit') ? Number(query.get('limit')) : undefined,
    };
    const tasks = taskService.listTasks(filters);
    sendJson(res, 200, { tasks, total: tasks.length });
  });

  router.get('/api/tasks/:id', ({ params, res, query }) => {
    if (query.get('context') === '1') {
      sendJson(res, 200, contextService.build(params.id));
      return;
    }
    sendJson(res, 200, { task: taskService.getTaskCard(params.id) });
  });

  router.get('/api/tasks/:id/context', ({ params, res }) => {
    sendJson(res, 200, contextService.build(params.id));
  });

  router.post('/api/tasks', ({ body, res }) => {
    const card = taskService.createTask({
      title: requireBodyField<string>(body, 'title'),
      type: bodyField<string>(body, 'type') && isTaskType(bodyField<string>(body, 'type'))
        ? assertTaskType(bodyField<string>(body, 'type'))
        : 'task',
      description: bodyField<string>(body, 'description') ?? '',
      status: bodyField<string>(body, 'status') ? assertTaskStatus(bodyField<string>(body, 'status')) : 'backlog',
      parentId: bodyField<string | null>(body, 'parentId') ?? null,
      tags: bodyField<string[]>(body, 'tags') ?? [],
      requiresManualTest: bodyField<boolean>(body, 'requiresManualTest') ?? false,
      images: bodyField<string[]>(body, 'images') ?? [],
      relatedTaskIds: bodyField<string[]>(body, 'relatedTaskIds') ?? [],
      initialComment: bodyField<string>(body, 'initialComment'),
      actor: 'user',
    });
    sendJson(res, 201, { task: card });
  });

  router.patch('/api/tasks/:id', ({ params, body, res }) => {
    const card = taskService.updateTask({
      id: params.id,
      title: bodyField<string>(body, 'title'),
      description: bodyField<string>(body, 'description'),
      type: bodyField<string>(body, 'type') ? assertTaskType(bodyField<string>(body, 'type')) : undefined,
      tags: Array.isArray(bodyField<string[]>(body, 'tags')) ? bodyField<string[]>(body, 'tags') : undefined,
      addTags: Array.isArray(bodyField<string[]>(body, 'addTags')) ? bodyField<string[]>(body, 'addTags') : undefined,
      removeTags: Array.isArray(bodyField<string[]>(body, 'removeTags'))
        ? bodyField<string[]>(body, 'removeTags')
        : undefined,
      requiresManualTest: bodyField<boolean>(body, 'requiresManualTest'),
      images: Array.isArray(bodyField<string[]>(body, 'images')) ? bodyField<string[]>(body, 'images') : undefined,
      parentId: body && typeof body === 'object' && 'parentId' in body ? bodyField<string | null>(body, 'parentId') ?? null : undefined,
      actor: 'user',
    });
    sendJson(res, 200, { task: card });
  });

  router.delete('/api/tasks/:id', ({ params, res }) => {
    const deleted = taskService.deleteTask(params.id, 'user');
    sendJson(res, deleted ? 200 : 404, { success: deleted, deleted: params.id });
  });

  router.post('/api/tasks/:id/status', ({ params, body, res }) => {
    const card = taskService.setStatus({
      id: params.id,
      status: assertTaskStatus(bodyField<string>(body, 'status')),
      comment: bodyField<string>(body, 'comment'),
      actor: 'user',
    });
    sendJson(res, 200, { task: card });
  });

  router.post('/api/tasks/:id/move', ({ params, body, res }) => {
    const status = bodyField<string>(body, 'status');
    const card = taskService.moveTask({
      id: params.id,
      status: status ? assertTaskStatus(status) : undefined,
      beforeId: bodyField<string>(body, 'beforeId'),
      afterId: bodyField<string>(body, 'afterId'),
      toIndex: bodyField<number>(body, 'toIndex'),
      actor: 'user',
    });
    sendJson(res, 200, { task: card });
  });

  router.post('/api/tasks/:id/comments', ({ params, body, res }) => {
    const comment = taskService.addComment({
      id: params.id,
      text: requireBodyField<string>(body, 'text'),
      author: bodyField<string>(body, 'author') ?? 'User',
      kind: (bodyField<string>(body, 'kind') as never) ?? 'note',
      actor: 'user',
    });
    sendJson(res, 201, { comment });
  });

  router.post('/api/tasks/:id/questions', ({ params, body, res }) => {
    const questions = bodyField<string[]>(body, 'questions');
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('Поле "questions" должно быть непустым массивом.');
    }
    const result = taskService.askQuestions({
      id: params.id,
      questions,
      phase: (bodyField<string>(body, 'phase') as QuestionPhase | undefined) ?? undefined,
      askedBy: 'User',
      actor: 'user',
    });
    sendJson(res, 201, { task: result.task, questions: result.questions });
  });

  router.post('/api/tasks/:id/questions/:questionId/answer', ({ params, body, res }) => {
    const result = taskService.answerQuestions({
      id: params.id,
      answers: [{ questionId: Number(params.questionId), answer: requireBodyField<string>(body, 'answer') }],
      answeredBy: bodyField<string>(body, 'answeredBy') ?? 'User',
      actor: 'user',
    });
    sendJson(res, 200, { task: result.task, answered: result.answered });
  });

  router.delete('/api/tasks/:id/questions/:questionId', ({ params, res }) => {
    const removed = app.repos.questions.removeById(Number(params.questionId));
    sendJson(res, removed ? 200 : 404, { success: removed, questionId: Number(params.questionId) });
  });

  router.post('/api/tasks/:id/answers', ({ params, body, res }) => {
    const answers = bodyField<{ questionId?: number; questionIndex?: number; answer: string }[]>(body, 'answers');
    if (!Array.isArray(answers) || answers.length === 0) {
      throw new Error('Поле "answers" должно быть непустым массивом.');
    }
    const result = taskService.answerQuestions({
      id: params.id,
      answers,
      answeredBy: bodyField<string>(body, 'answeredBy') ?? 'User',
      actor: 'user',
    });
    sendJson(res, 200, { task: result.task, answered: result.answered });
  });

  router.post('/api/tasks/:id/plan', ({ params, body, res }) => {
    const result = taskService.attachPlan({
      id: params.id,
      planContent: requireBodyField<string>(body, 'content'),
      fileName: bodyField<string>(body, 'name'),
      summary: bodyField<string>(body, 'summary'),
      questions: bodyField<string[]>(body, 'questions') ?? [],
      phase: (bodyField<string>(body, 'phase') as QuestionPhase | undefined) ?? undefined,
      statusMode: bodyField<string>(body, 'statusMode') === 'none' ? 'none' : 'auto',
      actor: 'user',
    });
    sendJson(res, 201, { task: result.task, plan: result.plan, questions: result.questions });
  });

  router.post('/api/tasks/:id/clarifications', ({ params, body, res }) => {
    const result = taskService.recordClarification({
      id: params.id,
      clarification: requireBodyField<string>(body, 'clarification'),
      reason: bodyField<string>(body, 'reason'),
      impact: bodyField<string>(body, 'impact'),
      planChanged: bodyField<boolean>(body, 'planChanged'),
      questions: bodyField<string[]>(body, 'questions') ?? [],
      phase: (bodyField<string>(body, 'phase') as QuestionPhase | undefined) ?? undefined,
      actor: 'user',
    });
    sendJson(res, 201, { task: result.task, event: result.event, questions: result.questions });
  });

  router.post('/api/tasks/:id/attachments', ({ params, body, res }) => {
    const attachment = taskService.addAttachment(
      params.id,
      {
        name: requireBodyField<string>(body, 'name'),
        content: requireBodyField<string>(body, 'content'),
        kind: resolveAttachmentKind(bodyField<string>(body, 'kind')),
      },
      'user',
    );
    sendJson(res, 201, { attachment });
  });

  router.delete('/api/tasks/:id/attachments/:attachmentId', ({ params, res }) => {
    const removed = app.repos.attachments.removeAttachment(Number(params.attachmentId));
    sendJson(res, removed ? 200 : 404, { success: removed, attachmentId: Number(params.attachmentId) });
  });

  router.post('/api/tasks/:id/images', ({ params, body, res }) => {
    const url = requireBodyField<string>(body, 'url');
    const image = app.repos.images.add(params.id, url, new Date().toISOString());
    sendJson(res, 201, { image });
  });

  router.post('/api/tasks/:id/links', ({ params, body, res }) => {
    const card = taskService.linkTasks(
      params.id,
      requireBodyField<string>(body, 'linkedTaskId'),
      (bodyField<string>(body, 'relation') as LinkRelation | undefined) ?? 'related',
      'user',
    );
    sendJson(res, 201, { task: card });
  });

  router.delete('/api/tasks/:id/links/:linkedTaskId', ({ params, res }) => {
    const card = taskService.unlinkTasks(
      params.id,
      params.linkedTaskId,
      undefined,
      'user',
    );
    sendJson(res, 200, { task: card });
  });
}
