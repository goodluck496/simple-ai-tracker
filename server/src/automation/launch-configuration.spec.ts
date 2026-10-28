import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { PipelinePolicy } from '../../../shared/automation/pipeline-policy.js';

test('analyst-only needs a repository but no code checks; configuration failures name the missing setting', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const settings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
      connections: [{ id: 'n', label: 'Native', kind: 'native' as const, supportsImages: false }],
      agents: (['analyst', 'developer'] as const).map(role => ({ id: role, role, runner: 'codex' as const, model: 'fixture', connectionId: 'n', instructions: '' })),
      pipeline: ['analyst'], checks: [] };
    const task = app.taskService.createTask({ title: 'Analysis without plan' });
    assert.deepEqual(PipelinePolicy.configurationProblems(settings), []);
    assert.throws(() => app.automationService.enqueue(task.id, { ...settings, repositoryPath: '' }, false), /Не указана папка Git-проекта/);
    assert.throws(() => app.automationService.enqueue(task.id, { ...settings, pipeline: [] }, false), /Не выбраны этапы/);
    assert.throws(() => app.automationService.enqueue(task.id, { ...settings, pipeline: ['analyst', 'developer'] }, false), /Для изменения кода нужны команды проверок/);
    const run = app.automationService.enqueue(task.id, settings, false);
    assert.deepEqual(run.settings.pipeline, ['analyst']);
    assert.deepEqual(run.settings.checks, []);
  } finally { app.close(); }
});
