import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { createContainer, type AppContainer } from '../bootstrap/container.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';
import { TrackerToolRegistry } from './tools.js';

function createApp(): AppContainer {
  return createContainer({
    config: { dbPath: ':memory:', idPrefix: 'SAT' },
    db: new NodeSqliteDatabase({ file: ':memory:' }),
    logger: new SilentLogger(),
  });
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const [first] = result.content;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Ожидался текстовый ответ MCP');
  }
  return first.text;
}

function parse(result: { content: readonly { type: string; text?: string }[] }): unknown {
  return JSON.parse(textOf(result));
}

describe('MCP-инструменты', () => {
  let app: AppContainer;
  let registry: TrackerToolRegistry;

  beforeEach(() => {
    app = createApp();
    registry = new TrackerToolRegistry(app);
  });

  it('публикует полный набор инструментов жизненного цикла', () => {
    const names = registry.definitions().map((tool) => tool.name);
    for (const expected of [
      'tracker_get_instructions',
      'tracker_get_task',
      'tracker_list_tasks',
      'tracker_search_tasks',
      'tracker_get_next_task',
      'tracker_create_task',
      'tracker_update_task',
      'tracker_set_status',
      'tracker_add_comment',
      'tracker_ask_questions',
      'tracker_answer_questions',
      'tracker_attach_plan',
      'tracker_record_clarification',
      'tracker_add_attachment',
      'tracker_link_tasks',
      'tracker_unlink_tasks',
      'tracker_list_tags',
      'tracker_add_tag',
      'tracker_verify_task',
    ]) {
      assert.ok(names.includes(expected), `нет инструмента ${expected}`);
    }
    assert.equal(new Set(names).size, names.length, 'имена инструментов уникальны');
  });

  it('отдаёт жёсткие инструкции и требует MCP-доступ', async () => {
    const result = await registry.call('tracker_get_instructions', {});
    const text = textOf(result);
    assert.match(text, /grep/i);
    assert.match(text, /tracker_get_task/);
    assert.match(text, /done/);
    assert.equal(result.isError, undefined);
  });

  it('создаёт задачу и возвращает контекст-пак', async () => {
    const created = await registry.call('tracker_create_task', {
      title: 'Новая задача',
      type: 'task',
      tags: ['ui'],
      requiresManualTesting: true,
    });
    const payload = parse(created) as { created: string; context: { id: string; status: string; requiresManualTest: boolean; nextActions: string[] } };
    assert.equal(payload.created, 'SAT-1');
    assert.equal(payload.context.status, 'backlog');
    assert.equal(payload.context.requiresManualTest, true);
    assert.ok(payload.context.nextActions.length > 0);
  });

  it('проводит полный цикл: вопросы → ответы → план → реализация → тесты → review', async () => {
    await registry.call('tracker_create_task', { title: 'Цикл', type: 'task' });

    const asked = parse(
      await registry.call('tracker_ask_questions', { id: 'SAT-1', questions: ['Вопрос A?'], phase: 'planning' }),
    ) as { status: string; questions: { id: number }[] };
    assert.equal(asked.status, 'questions');

    const answered = parse(
      await registry.call('tracker_answer_questions', {
        id: 'SAT-1',
        answers: [{ questionId: asked.questions[0].id, answer: 'Ответ A' }],
      }),
    ) as { status: string; openQuestions: number };
    assert.equal(answered.openQuestions, 0);
    assert.equal(answered.status, 'planning');

    const withPlan = parse(
      await registry.call('tracker_attach_plan', { id: 'SAT-1', planContent: '# План\n1. Сделать', fileName: 'plan.md' }),
    ) as { status: string; planVersion: number };
    assert.equal(withPlan.planVersion, 1);
    assert.equal(withPlan.status, 'ready');

    const inProgress = textOf(await registry.call('tracker_set_status', { id: 'SAT-1', status: 'in_progress' }));
    assert.match(inProgress, /in_progress/);

    const testing = textOf(await registry.call('tracker_set_status', { id: 'SAT-1', status: 'testing' }));
    assert.match(testing, /testing/);

    const review = textOf(await registry.call('tracker_set_status', { id: 'SAT-1', status: 'review' }));
    assert.match(review, /review/);
  });

  it('запрещает агенту статус done и возвращает понятную ошибку', async () => {
    await registry.call('tracker_create_task', { title: 'Не закрывать', status: 'review' });
    const result = await registry.call('tracker_set_status', { id: 'SAT-1', status: 'done' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /STATUS_REQUIRES_USER/);
  });

  it('фиксирует уточнение и требует новую версию плана', async () => {
    await registry.call('tracker_create_task', { title: 'Уточнение', status: 'in_progress' });
    await registry.call('tracker_attach_plan', { id: 'SAT-1', planContent: '# План v1' });

    const clarification = parse(
      await registry.call('tracker_record_clarification', {
        id: 'SAT-1',
        clarification: 'Нужна поддержка LOD',
        reason: 'производительность',
        impact: 'меняется структура чанков',
        planChanged: true,
      }),
    ) as { status: string; planVersion: number | null; reminder: string };
    assert.equal(clarification.planVersion, 1);
    assert.match(clarification.reminder, /новую версию/);

    const context = parse(await registry.call('tracker_get_task', { id: 'SAT-1' })) as {
      decisionLog: { type: string; details: Record<string, unknown> }[];
      description: string;
    };
    const entry = context.decisionLog.find((item) => item.type === 'clarification');
    assert.ok(entry, 'уточнение попало в журнал решений');
    assert.equal(entry?.details['planChanged'], true);
    assert.match(context.description, /Нужна поддержка LOD/);

    const secondPlan = parse(
      await registry.call('tracker_attach_plan', { id: 'SAT-1', planContent: '# План v2' }),
    ) as { planVersion: number };
    assert.equal(secondPlan.planVersion, 2);
  });

  it('ищет задачи и отдаёт компактный список', async () => {
    await registry.call('tracker_create_task', { title: 'Воксельный движок', type: 'task', tags: ['voxel'] });
    await registry.call('tracker_create_task', { title: 'Инвентарь', type: 'feature', tags: ['ui'] });

    const found = parse(await registry.call('tracker_search_tasks', { query: 'воксел' })) as { id: string }[];
    assert.deepEqual(
      found.map((item) => item.id),
      ['SAT-1'],
    );

    const filtered = parse(await registry.call('tracker_list_tasks', { tag: 'ui' })) as { id: string }[];
    assert.deepEqual(
      filtered.map((item) => item.id),
      ['SAT-2'],
    );
  });

  it('возвращает компактный отчёт верификации и ловит рассинхрон статуса', async () => {
    await registry.call('tracker_create_task', { title: 'Проверка', status: 'ready' });

    const report = parse(await registry.call('tracker_verify_task', { id: 'SAT-1' })) as {
      valid: boolean;
      warnings: string[];
      counts: Record<string, number>;
      plan: { present: boolean };
    };
    assert.equal(report.plan.present, false);
    assert.ok(report.warnings.some((warning) => warning.includes('без прикреплённого плана')));

    const missing = await registry.call('tracker_verify_task', { id: 'SAT-404' });
    const missingReport = parse(missing) as { valid: boolean; errors: string[] };
    assert.equal(missingReport.valid, false);
    assert.match(missingReport.errors[0], /не найдена/);
  });

  it('берёт следующую готовую задачу', async () => {
    await registry.call('tracker_create_task', { title: 'Готова', status: 'ready' });
    const claimed = parse(await registry.call('tracker_get_next_task', {})) as { claimed: string; status: string };
    assert.equal(claimed.claimed, 'SAT-1');
    assert.equal(claimed.status, 'in_progress');

    const empty = await registry.call('tracker_get_next_task', {});
    assert.match(textOf(empty), /Нет задач/);
  });

  it('валидирует аргументы и неизвестные инструменты', async () => {
    const missing = await registry.call('tracker_get_task', {});
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /VALIDATION_FAILED/);

    const unknown = await registry.call('tracker_nope', {});
    assert.equal(unknown.isError, true);
  });
});
