import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { createContainer, type AppContainer } from '../bootstrap/container.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';
import type { Clock } from './task-service.js';
import { TrackerError } from '../core/errors.js';

/** Детерминированные часы: время в тестах не «плывёт». */
class FixedClock implements Clock {
  private tick = 0;
  public constructor(private readonly start = '2026-01-01T00:00:00.000Z') {}
  public now(): string {
    const base = new Date(this.start).getTime() + this.tick * 1000;
    this.tick += 1;
    return new Date(base).toISOString();
  }
}

function createTestApp(): AppContainer {
  return createContainer({
    config: { dbPath: ':memory:', idPrefix: 'SAT' },
    db: new NodeSqliteDatabase({ file: ':memory:' }),
    clock: new FixedClock(),
    logger: new SilentLogger(),
  });
}

describe('TaskService', () => {
  let app: AppContainer;

  beforeEach(() => {
    app = createTestApp();
  });

  it('создаёт задачу с последовательным ID и статусом backlog', () => {
    const first = app.taskService.createTask({ title: 'Первая задача', type: 'task' });
    const second = app.taskService.createTask({ title: 'Вторая задача', type: 'bug' });

    assert.equal(first.id, 'SAT-1');
    assert.equal(first.status, 'backlog');
    assert.equal(second.id, 'SAT-2');
    assert.deepEqual(
      app.taskService.listTasks({}).map((task) => task.id),
      ['SAT-1', 'SAT-2'],
    );
  });

  it('нормализует и сохраняет теги задачи', () => {
    const task = app.taskService.createTask({ title: 'С тегами', tags: ['UI', ' bug ', 'ui'] });
    assert.deepEqual(
      task.tags.map((tag) => tag.name),
      ['bug', 'ui'],
    );
  });

  it('переводит карточку в questions при вопросах и в planning после ответов без плана', () => {
    const task = app.taskService.createTask({ title: 'С вопросами' });
    const asked = app.taskService.askQuestions({ id: task.id, questions: ['Нужен ли туман?', 'Какая дальность?'] });

    assert.equal(asked.task.status, 'questions');
    assert.equal(asked.task.openQuestionsCount, 2);

    const answered = app.taskService.answerQuestions({
      id: task.id,
      answers: [
        { questionId: asked.questions[0].id, answer: 'Да, нужен' },
        { questionId: asked.questions[1].id, answer: '12 метров' },
      ],
    });

    assert.equal(answered.task.openQuestionsCount, 0);
    assert.equal(answered.task.status, 'planning');
  });

  it('прикрепляет план с вопросами (questions) и переводит в ready после ответов', () => {
    const task = app.taskService.createTask({ title: 'План и вопросы' });
    const attached = app.taskService.attachPlan({
      id: task.id,
      planContent: '# План\n\n1. Сделать A\n2. Сделать B',
      fileName: 'plan-SAT-1.md',
      questions: ['Уточнить A?'],
    });

    assert.equal(attached.plan.version, 1);
    assert.equal(attached.task.status, 'questions');
    assert.equal(attached.task.plan?.content.includes('Сделать A'), true);

    const answered = app.taskService.answerQuestions({
      id: task.id,
      answers: [{ questionId: attached.questions[0].id, answer: 'Да' }],
    });

    assert.equal(answered.task.status, 'ready');
  });

  it('версионирует планы и сохраняет историю решений', () => {
    const task = app.taskService.createTask({ title: 'Версии плана' });
    app.taskService.attachPlan({ id: task.id, planContent: '# План v1', fileName: 'plan.md' });
    app.taskService.attachPlan({ id: task.id, planContent: '# План v2 (после уточнения)', fileName: 'plan.md' });

    const card = app.taskService.getTaskCard(task.id);
    assert.equal(card.plan?.version, 2);
    assert.equal(card.plan?.content, '# План v2 (после уточнения)');
    assert.deepEqual(
      card.planHistory.map((revision) => revision.version),
      [1, 2],
    );
    assert.equal(card.planHistory.filter((revision) => revision.isCurrent).length, 1);
  });

  it('не переводит карточку в ready, пока есть открытые вопросы', () => {
    const task = app.taskService.createTask({ title: 'План при открытых вопросах' });
    app.taskService.askQuestions({ id: task.id, questions: ['Нужен ли туман?'] });

    const attached = app.taskService.attachPlan({
      id: task.id,
      planContent: '# План\n1. Шаг',
      fileName: 'plan.md',
    });
    assert.equal(attached.task.status, 'questions', 'открытый вопрос удерживает карточку в questions');
    assert.equal(attached.task.openQuestionsCount, 1);

    const verify = app.verificationService.verify(task.id);
    assert.equal(verify.valid, true);
    assert.equal(verify.errors.length, 0);

    const answered = app.taskService.answerQuestions({
      id: task.id,
      answers: [{ questionId: attached.task.unansweredQuestions[0].id, answer: 'Да' }],
    });
    assert.equal(answered.task.status, 'ready', 'после ответов план уже есть — карточка готова');
  });

  it('фиксирует уточнение пользователя в описании, журнале и переводит в questions при вопросах', () => {
    const task = app.taskService.createTask({ title: 'Уточнение по ходу', status: 'in_progress' });
    const result = app.taskService.recordClarification({
      id: task.id,
      clarification: 'Нужно хранить историю планов',
      reason: 'пользователь хочет видеть, от чего шли и к чему пришли',
      impact: 'план требует новой версии',
      planChanged: true,
      questions: ['Хранить все версии или только последние 5?'],
    });

    assert.equal(result.task.status, 'questions');
    assert.match(result.task.description, /Дополнительные требования пользователя/);
    assert.match(result.task.description, /Нужно хранить историю планов/);
    assert.equal(result.event.type, 'clarification');
    assert.equal(result.questions.length, 1);

    const context = app.contextService.build(task.id);
    assert.ok(context.decisionLog.some((entry) => entry.type === 'clarification'));
  });

  it('запрещает агенту переводить задачу в done', () => {
    const task = app.taskService.createTask({ title: 'Только пользователь', status: 'review', requiresManualTest: true });
    assert.throws(
      () => app.taskService.setStatus({ id: task.id, status: 'done', actor: 'agent' }),
      (error: unknown) => error instanceof TrackerError && error.code === 'STATUS_REQUIRES_USER',
    );

    const closed = app.taskService.setStatus({ id: task.id, status: 'done', actor: 'user' });
    assert.equal(closed.status, 'done');
  });

  it('запрещает недопустимые переходы статусов', () => {
    const task = app.taskService.createTask({ title: 'Прыжок через статусы' });
    assert.throws(
      () => app.taskService.setStatus({ id: task.id, status: 'review' }),
      (error: unknown) => error instanceof TrackerError && error.code === 'INVALID_TRANSITION',
    );
  });

  it('ищет задачи по тексту, тегу и ID', () => {
    const task = app.taskService.createTask({
      title: 'Воксельный мешер',
      description: 'Greedy meshing для чанков',
      tags: ['voxel', 'performance'],
    });
    app.taskService.addComment({ id: task.id, text: 'Нужен бенчмарк чанков' });

    assert.deepEqual(
      app.taskService.searchTasks({ query: 'мешер' }).map((item) => item.id),
      [task.id],
    );
    assert.deepEqual(
      app.taskService.searchTasks({ query: 'bench', scope: 'comments' }).map((item) => item.id),
      [],
    );
    assert.deepEqual(
      app.taskService.searchTasks({ query: 'бенчмарк', scope: 'comments' }).map((item) => item.id),
      [task.id],
    );
    assert.deepEqual(
      app.taskService.listTasks({ tag: 'voxel' }).map((item) => item.id),
      [task.id],
    );
    assert.deepEqual(
      app.taskService.searchTasks({ query: 'sat-1', scope: 'id' }).map((item) => item.id),
      [task.id],
    );
  });

  it('ищет по нескольким выбранным полям одновременно', () => {
    const byTitle = app.taskService.createTask({ title: 'Туман в изометрии', description: 'графика' });
    const byComment = app.taskService.createTask({ title: 'Другое', description: 'описание' });
    app.taskService.addComment({ id: byComment.id, text: 'Туман нужен плотный' });

    // Только заголовок: вторая карточка не попадает.
    assert.deepEqual(
      app.taskService.searchTasks({ query: 'туман', scopes: ['title'] }).map((item) => item.id),
      [byTitle.id],
    );

    // Заголовок + комментарии: попадают обе.
    assert.deepEqual(
      app.taskService.searchTasks({ query: 'туман', scopes: ['title', 'comments'] }).map((item) => item.id).sort(),
      [byTitle.id, byComment.id].sort(),
    );

    // Только комментарии: первая не попадает.
    assert.deepEqual(
      app.taskService.searchTasks({ query: 'туман', scopes: ['comments'] }).map((item) => item.id),
      [byComment.id],
    );
  });

  it('связывает задачи и отдаёт связи с обеих сторон', () => {
    const blocker = app.taskService.createTask({ title: 'Блокирующая' });
    const blocked = app.taskService.createTask({ title: 'Заблокированная' });
    app.taskService.linkTasks(blocked.id, blocker.id, 'blocked_by');

    const blockedContext = app.contextService.build(blocked.id);
    assert.equal(blockedContext.relations.links[0].relation, 'blocked_by');
    assert.equal(blockedContext.relations.links[0].task.id, blocker.id);

    const blockerContext = app.contextService.build(blocker.id);
    assert.equal(blockerContext.relations.links[0].relation, 'blocks');
  });

  it('переставляет карточки внутри колонки и между колонками', () => {
    const a = app.taskService.createTask({ title: 'A' });
    const b = app.taskService.createTask({ title: 'B' });
    const c = app.taskService.createTask({ title: 'C' });

    const order = (): string[] => app.taskService.listTasks({ status: 'backlog' }).map((task) => task.id);
    assert.deepEqual(order(), [a.id, b.id, c.id]);

    app.taskService.moveTask({ id: c.id, beforeId: a.id, actor: 'user' });
    assert.deepEqual(order(), [c.id, a.id, b.id]);

    app.taskService.moveTask({ id: a.id, status: 'planning', actor: 'agent' });
    assert.deepEqual(
      app.taskService.listTasks({ status: 'planning' }).map((task) => task.id),
      [a.id],
    );
  });

  it('удаляет задачу вместе с комментариями и подзадачами', () => {
    const parent = app.taskService.createTask({ title: 'Родитель', type: 'feature' });
    const child = app.taskService.createTask({ title: 'Потомок', parentId: parent.id });
    app.taskService.addComment({ id: child.id, text: 'Комментарий' });

    app.taskService.deleteTask(parent.id);

    assert.equal(app.taskService.getSummary(parent.id), null);
    assert.equal(app.taskService.getSummary(child.id), null);
    const commentsLeft = app.repos.comments.listByTask(child.id);
    assert.equal(commentsLeft.length, 0);
  });
});
