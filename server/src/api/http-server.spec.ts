import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createContainer, type AppContainer } from '../bootstrap/container.js';
import { createApiServer } from './http-server.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';

let app: AppContainer;
let server: Server;
let baseUrl: string;

async function request<T>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

before(async () => {
  app = createContainer({
    config: { dbPath: ':memory:', idPrefix: 'SAT' },
    db: new NodeSqliteDatabase({ file: ':memory:' }),
    logger: new SilentLogger(),
  });
  server = createApiServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close();
});

describe('HTTP API', () => {
  it('отдаёт health и метаданные со всеми статусами', async () => {
    const health = await request<{ status: string; app: string }>('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.app, 'simple-ai-tracker');

    const meta = await request<{ statuses: { status: string }[]; app: { idPrefix: string } }>('/api/meta');
    assert.equal(meta.status, 200);
    assert.equal(meta.body.statuses.length, 8);
    assert.equal(meta.body.app.idPrefix, 'SAT');
  });

  it('создаёт карточку, отдаёт её и список', async () => {
    const created = await request<{ task: { id: string; status: string; title: string } }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'Первая API задача', type: 'task', tags: ['api'] }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.task.id, 'SAT-1');
    assert.equal(created.body.task.status, 'backlog');

    const list = await request<{ tasks: { id: string }[]; total: number }>('/api/tasks');
    assert.equal(list.body.total, 1);

    const card = await request<{ task: { id: string; tags: { name: string }[] } }>('/api/tasks/SAT-1');
    assert.equal(card.body.task.id, 'SAT-1');
    assert.deepEqual(
      card.body.task.tags.map((tag) => tag.name),
      ['api'],
    );

    const missing = await request<{ error: { code: string } }>('/api/tasks/SAT-404');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'TASK_NOT_FOUND');
  });

  it('пользователь проходит цикл вопросов и закрывает задачу в done', async () => {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'С вопросами' }) });

    const asked = await request<{ task: { status: string }; questions: { id: number }[] }>('/api/tasks/SAT-1/questions', {
      method: 'POST',
      body: JSON.stringify({ questions: ['Нужен ли туман?'], phase: 'planning' }),
    });
    assert.equal(asked.body.task.status, 'questions');

    const questionId = asked.body.questions[0].id;
    const answered = await request<{ task: { status: string } }>(`/api/tasks/SAT-1/questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: 'Да' }),
    });
    assert.equal(answered.body.task.status, 'planning');

    const planned = await request<{ task: { status: string }; plan: { version: number } }>('/api/tasks/SAT-1/plan', {
      method: 'POST',
      body: JSON.stringify({ content: '# План\n1. Шаг', name: 'plan-SAT-1.md' }),
    });
    assert.equal(planned.body.task.status, 'ready');
    assert.equal(planned.body.plan.version, 1);

    const done = await request<{ task: { status: string } }>('/api/tasks/SAT-1/status', {
      method: 'POST',
      body: JSON.stringify({ status: 'done', comment: 'проверено вручную' }),
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.task.status, 'done');
  });

  it('фиксирует уточнение и отдаёт контекст-пак агенту', async () => {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Уточнение через API', status: 'in_progress' }) });

    const clarification = await request<{ task: { status: string; description: string } }>(
      '/api/tasks/SAT-2/clarifications',
      {
        method: 'POST',
        body: JSON.stringify({
          clarification: 'Нужен журнал версий плана',
          reason: 'чтобы видеть историю',
          impact: 'новая таблица',
          planChanged: true,
          questions: ['Сколько версий хранить?'],
        }),
      },
    );
    assert.equal(clarification.body.task.status, 'questions');
    assert.match(clarification.body.task.description, /Дополнительные требования пользователя/);

    const context = await request<{ decisionLog: { type: string }[]; workflow: { guidance: string } }>(
      '/api/tasks/SAT-2/context',
    );
    assert.ok(context.body.decisionLog.some((entry) => entry.type === 'clarification'));
    assert.ok(context.body.workflow.guidance.length > 0);
  });

  it('управляет тегами и связями', async () => {
    const tag = await request<{ tag: { name: string } }>('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ name: 'Backend', color: '#123456' }),
    });
    assert.equal(tag.body.tag.name, 'backend');

    const tags = await request<{ tags: { name: string }[] }>('/api/tags');
    assert.ok(tags.body.tags.some((item) => item.name === 'backend'));

    const linked = await request<{ task: { links: { relation: string }[] } }>('/api/tasks/SAT-1/links', {
      method: 'POST',
      body: JSON.stringify({ linkedTaskId: 'SAT-2', relation: 'blocks' }),
    });
    assert.equal(linked.body.task.links.length >= 1, true);

    const unlinked = await request<{ task: { links: unknown[] } }>('/api/tasks/SAT-1/links/SAT-2', { method: 'DELETE' });
    assert.equal(unlinked.status, 200);

    const removed = await request<{ success: boolean }>('/api/tags/backend', { method: 'DELETE' });
    assert.equal(removed.body.success, true);
  });

  it('валидирует недопустимые данные и неизвестные маршруты', async () => {
    const invalid = await request<{ error: { code: string } }>('/api/tasks', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');

    const invalidStatus = await request<{ error: { code: string } }>('/api/tasks/SAT-1/status', {
      method: 'POST',
      body: JSON.stringify({ status: 'нет-такого' }),
    });
    assert.equal(invalidStatus.status, 400);

    const missingRoute = await request<{ error: { code: string } }>('/api/nope');
    assert.equal(missingRoute.status, 404);
  });

  it('отдаёт markdown-инструкцию для агента', async () => {
    const response = await fetch(`${baseUrl}/api/instructions`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /tracker_get_task/);
  });
});
