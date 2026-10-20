import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createContainer, type AppContainer } from '../bootstrap/container.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';
import { ImportService, detectCommentKind, eventTypeForCommentKind, mapLegacyStatus } from './import-service.js';

function createApp(): AppContainer {
  return createContainer({
    config: { dbPath: ':memory:' },
    db: new NodeSqliteDatabase({ file: ':memory:' }),
    logger: new SilentLogger(),
  });
}

/** Готовит каталог legacy-проекта: tasks.json, tasks/*.json, tags.json, docs/plans/*.md. */
function createLegacyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-legacy-'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'plans'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'tags.json'),
    JSON.stringify({ tags: [{ id: 'voxel', name: 'voxel', color: '#38bdf8', description: 'воксели' }] }, null, 2),
    'utf8',
  );

  const feature = {
    id: 'MS-1',
    title: 'Фича про мир',
    description: 'Описание фичи',
    type: 'feature',
    status: 'progress',
    parentId: null,
    order: 1,
    images: [],
    comments: [],
    tags: ['voxel'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  const planContent = '# План MS-2\n\n1. Шаг\n';
  fs.writeFileSync(path.join(dir, 'docs', 'plans', 'MS-2.md'), planContent, 'utf8');

  const child = {
    id: 'MS-2',
    title: 'Задача про чанки',
    description: 'Описание задачи',
    type: 'task',
    status: 'pending',
    parentId: 'MS-1',
    order: 2,
    images: ['data:image/png;base64,AAA'],
    tags: [],
    attachments: [
      { id: 'att-1', name: 'MS-2.md', path: 'docs/plans/MS-2.md', size: planContent.length, createdAt: '2026-01-03T00:00:00.000Z' },
    ],
    comments: [
      { id: 'c-1', author: 'AI Agent', text: '[PROGRESS] Взял в работу', createdAt: '2026-01-03T01:00:00.000Z' },
      {
        id: 'c-2',
        author: 'AI Agent',
        text: '[USER REQUIREMENTS] Добавлено требование: "нужен LOD". Обоснование: "производительность".',
        createdAt: '2026-01-03T02:00:00.000Z',
      },
      { id: 'c-3', author: 'User', text: 'Обычный комментарий', createdAt: '2026-01-03T03:00:00.000Z' },
    ],
    questions: [
      { id: 'q-1', text: 'Нужен ли туман?', createdAt: '2026-01-03T04:00:00.000Z' },
      { id: 'q-2', text: 'Какая дальность?', answer: '12 м', answeredAt: '2026-01-03T05:00:00.000Z', createdAt: '2026-01-03T04:00:00.000Z' },
    ],
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
  };

  fs.writeFileSync(path.join(dir, 'tasks', 'MS-1.json'), JSON.stringify(feature, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'tasks', 'MS-2.json'), JSON.stringify(child, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tasks: [feature, child] }, null, 2), 'utf8');

  return dir;
}

describe('ImportService (legacy JSON → SQLite)', () => {
  it('переносит задачи, теги, комментарии, вопросы, планы и связи', () => {
    const app = createApp();
    const sourceDir = createLegacyFixture();
    const report = new ImportService(app.repos, undefined, new SilentLogger()).importFromJson({ sourceDir });

    assert.equal(report.tasksImported, 2);
    assert.equal(report.tasksSkipped, 0);
    assert.equal(report.plans, 1);
    assert.equal(report.images, 1);
    assert.equal(report.comments, 3);
    assert.equal(report.questions, 2);
    assert.equal(report.tagsImported, 1);
    assert.equal(report.links, 1);

    const feature = app.taskService.getTaskCard('MS-1');
    assert.equal(feature.status, 'in_progress', 'legacy progress → in_progress');
    assert.equal(feature.type, 'feature');
    assert.deepEqual(feature.tags.map((tag) => tag.name), ['voxel']);

    const child = app.taskService.getTaskCard('MS-2');
    assert.equal(child.parentId, 'MS-1');
    assert.equal(child.status, 'questions', 'legacy pending → questions');
    assert.equal(child.plan?.version, 1);
    assert.match(child.plan?.content ?? '', /План MS-2/);
    assert.equal(child.openQuestionsCount, 1);
    assert.equal(child.questions.filter((question) => !question.isOpen).length, 1);
    assert.equal(child.comments.length, 3);
    assert.equal(child.comments[1].kind, 'requirement');
    assert.equal(child.images.length, 1);

    // decisionLog должен быть непустым: события восстановлены из комментариев.
    const context = app.contextService.build('MS-2');
    assert.ok(context.decisionLog.some((entry) => entry.type === 'clarification'));
    assert.ok(context.decisionLog.some((entry) => entry.type === 'plan_attached'));
    assert.ok(context.decisionLog.some((entry) => entry.type === 'status_changed'));
    app.close();
  });

  it('идемпотентен: повторный импорт не дублирует задачи, replace очищает базу', () => {
    const app = createApp();
    const sourceDir = createLegacyFixture();
    const service = new ImportService(app.repos, undefined, new SilentLogger());

    service.importFromJson({ sourceDir });
    const second = service.importFromJson({ sourceDir });
    assert.equal(second.tasksImported, 0);
    assert.equal(second.tasksSkipped, 2);
    assert.equal(app.taskService.getStats().total, 2);

    const replaced = service.importFromJson({ sourceDir, replace: true });
    assert.equal(replaced.tasksImported, 2);
    assert.equal(app.taskService.getStats().total, 2);
    app.close();
  });

  it('мапит legacy-статусы и определяет виды комментариев', () => {
    assert.equal(mapLegacyStatus('todo'), 'backlog');
    assert.equal(mapLegacyStatus('DiffOfReady'), 'ready');
    assert.equal(mapLegacyStatus('progress'), 'in_progress');
    assert.equal(mapLegacyStatus('test'), 'testing');
    assert.equal(mapLegacyStatus('done'), 'done');
    assert.equal(mapLegacyStatus('неведомый'), 'backlog');

    assert.equal(detectCommentKind('[USER REQUIREMENTS] текст'), 'requirement');
    assert.equal(detectCommentKind('[PENDING] план'), 'plan');
    assert.equal(detectCommentKind('[TEST] отчёт'), 'test-report');
    assert.equal(detectCommentKind('[PROGRESS] взял'), 'status');
    assert.equal(detectCommentKind('обычный текст'), 'note');

    assert.equal(eventTypeForCommentKind('requirement'), 'clarification');
    assert.equal(eventTypeForCommentKind('plan'), 'plan_attached');
    assert.equal(eventTypeForCommentKind('note'), null);
  });
});
