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
