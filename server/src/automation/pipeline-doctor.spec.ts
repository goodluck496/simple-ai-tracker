import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS, ProviderKind } from '../../../shared/automation/contracts.js';

test('pipeline doctor creates proposed fix and handles apply/discard', async () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const task = app.taskService.createTask({ title: 'Doctor fixture' });
    app.automationService.configure({
      ...structuredClone(DEFAULT_AUTOMATION_SETTINGS),
      repositoryPath: '/fixture',
      connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
      agents: [
        { id: 'a1', role: 'developer', runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' },
      ],
      pipeline: ['a1'],
      checks: [{ command: 'node', args: ['--version'] }],
    });
    const run = app.automationService.enqueue(task.id);
    const claimed = app.automationService.claim('fixture-worker')!;
    app.automationService.fail(claimed.id, claimed.leaseToken!, 'TypeScript build failed: ts(2304) Cannot find name AuthOptions');

    // Diagnose directly
    const fix = await app.automationService.diagnoseFix(run.id);
    assert.ok(fix.id);
    assert.match(fix.title, /синтаксиса|компиляции/);
    assert.ok(fix.explanation.includes('компиляции'));

    const detailWithFix = app.automationService.detail(run.id);
    assert.ok(detailWithFix.run.proposedFix);
    assert.equal(detailWithFix.item?.proposedFix?.id, fix.id);

    // Discard fix
    const discarded = await app.automationService.discardFix(run.id);
    assert.equal(discarded.proposedFix, null);
    assert.equal(app.automationService.detail(run.id).run.proposedFix, null);
  } finally {
    app.close();
  }
});

test('local connection preset automatically sets trustedExecution on new runs', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const task = app.taskService.createTask({ title: 'Local model fixture' });
    assert.equal(task.trustedExecution, false);

    app.automationService.configure({
      ...structuredClone(DEFAULT_AUTOMATION_SETTINGS),
      repositoryPath: '/fixture',
      connections: [
        { id: 'ollama-conn', label: 'Local Ollama', kind: ProviderKind.Ollama, baseUrl: 'http://localhost:11434', supportsImages: false, isLocal: true },
      ],
      agents: [
        { id: 'a1', role: 'developer', runner: 'model-api', connectionId: 'ollama-conn', model: 'qwen2.5-coder', instructions: '' },
      ],
      pipeline: ['a1'],
      checks: [{ command: 'node', args: ['--version'] }],
    });

    const run = app.automationService.enqueue(task.id);
    assert.equal(run.trustedExecution, true, 'Run with local model must have trustedExecution enabled automatically');
  } finally {
    app.close();
  }
});


test('doctor consults model and uses its recommendations', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            title: 'Анализ через локальную модель Ollama',
            explanation: 'Модель выявила отсутствие файла конфигурации',
            scope: 'worktree',
            action: 'patch_code'
          })
        }
      }]
    })
  });

  const { PipelineDoctor } = await import('./pipeline-doctor.js');
  const doctor = new PipelineDoctor(undefined, mockFetch as unknown as typeof fetch);

  const run: any = {
    id: 'run-1',
    taskId: 'TASK-1',
    stage: 0,
    summary: 'Build failure in module',
    settings: {
      ...DEFAULT_AUTOMATION_SETTINGS,
      doctorConnectionId: 'my-ollama',
      doctorModel: 'qwen2.5-coder:7b',
      connections: [
        { id: 'my-ollama', label: 'Моя Ollama', kind: ProviderKind.Ollama, baseUrl: 'http://localhost:11434', supportsImages: false, isLocal: true }
      ],
      agents: []
    }
  };

  const fix = await doctor.diagnose(run, ['error TS2304']);
  assert.equal(fix.title, 'Анализ через локальную модель Ollama');
  assert.equal(fix.explanation, 'Модель выявила отсутствие файла конфигурации');
  assert.equal(fix.model, 'Моя Ollama (qwen2.5-coder:7b)');
  assert.equal(fix.scope, 'worktree');
});

test('doctor detects clean target checkout failure and diagnoses repository scope', async () => {
  const { PipelineDoctor } = await import('./pipeline-doctor.js');
  const doctor = new PipelineDoctor();

  const run: any = {
    id: 'run-2',
    taskId: 'SAT-28',
    stage: 0,
    summary: 'Automatic integration requires a clean target checkout. Preserve its changes or select manual review before starting.',
    settings: {
      ...DEFAULT_AUTOMATION_SETTINGS,
      connections: [],
      agents: []
    }
  };

  const fix = await doctor.diagnose(run, ['Automatic integration requires a clean target checkout.']);
  assert.equal(fix.scope, 'repository');
  assert.equal(fix.action, 'commit_dirty_repo');
  assert.match(fix.title, /Сохранение локальных файлов/);
  assert.ok(fix.explanation.includes('Автоматическая интеграция требует чистого состояния'));
});


test('doctor respects doctorAgent profile configuration and custom instructions', async () => {
  let capturedBody: any;
  const mockFetch = async (_url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Специальный анализ доктор-агента',
              explanation: 'Диагностика по кастомной инструкции',
              scope: 'worktree',
              action: 'patch_code'
            })
          }
        }]
      })
    };
  };

  const { PipelineDoctor } = await import('./pipeline-doctor.js');
  const doctor = new PipelineDoctor(undefined, mockFetch as unknown as typeof fetch);

  const run: any = {
    id: 'run-doctor-agent',
    taskId: 'TASK-DOC',
    stage: 0,
    summary: 'Custom failure',
    settings: {
      ...DEFAULT_AUTOMATION_SETTINGS,
      connections: [
        { id: 'doc-conn', label: 'Доктор Коннект', kind: ProviderKind.Ollama, baseUrl: 'http://localhost:11434', supportsImages: false, isLocal: true }
      ],
      agents: [],
      doctorAgent: {
        id: 'pipeline-doctor',
        role: 'doctor',
        runner: 'model-api',
        connectionId: 'doc-conn',
        model: 'deepseek-coder:14b',
        instructions: 'КАСТОМНАЯ ИНСТРУКЦИЯ ДОКТОРА'
      }
    }
  };

  const fix = await doctor.diagnose(run, ['some error']);
  assert.equal(fix.title, 'Специальный анализ доктор-агента');
  assert.equal(fix.model, 'Доктор Коннект (deepseek-coder:14b)');
  assert.ok(capturedBody.messages[0].content.includes('КАСТОМНАЯ ИНСТРУКЦИЯ ДОКТОРА'));
});
