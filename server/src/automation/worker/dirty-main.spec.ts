import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitFixture } from './testing/git-fixture.js';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { PipelineWorker } from './pipeline-worker.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../../shared/automation/contracts.js';

test('manual review runs in a separate worktree while preserving unrelated main-checkout edits', async () => {
  const fixture = await gitFixture();
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    await fs.writeFile(path.join(fixture.repository, 'b.txt'), 'user change\n');
    const bridge = path.join(fixture.root, 'agent.cjs');
    await fs.writeFile(bridge, `require('node:fs').writeFileSync('a.txt','1\\n');console.log(JSON.stringify({verdict:'pass',summary:'Changed a.txt',commitMessage:'[#SAT-1] - Изменён ответ, чтобы проверить изолированную разработку'}));`);
    app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: fixture.repository, baseBranch: 'master',
      connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
      agents: [{ id: 'dev', role: 'developer', runner: 'custom', model: 'fixture', connectionId: 'fixture', instructions: '', command: process.execPath, args: [bridge] }], pipeline: ['dev'],
      checks: [{ command: process.execPath, args: ['-e', "const fs=require('node:fs'),assert=require('node:assert');assert.equal(fs.readFileSync('a.txt','utf8').trim(),'1');assert.equal(fs.readFileSync('b.txt','utf8').trim(),'0');"] }],
    });
    const task = app.taskService.createTask({ title: 'Change isolated answer' });
    app.taskService.attachPlan({ id: task.id, planContent: '1. Change a.txt to 1. Preserve b.txt.', actor: 'agent' });
    const registry = new TrackerToolRegistry(app);
    const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await registry.call(name, args);
      const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } }, 'dirty-main-fixture', fixture.executor);
    const run = app.automationService.enqueue(task.id); await worker.tick();
    const actual = app.automationService.detail(run.id).run;
    assert.equal(actual.status, 'review', actual.summary);
    assert.equal(await fs.readFile(path.join(fixture.repository, 'a.txt'), 'utf8'), '0\n');
    assert.equal(await fs.readFile(path.join(fixture.repository, 'b.txt'), 'utf8'), 'user change\n');
    assert.equal(await fs.readFile(path.join(actual.checkout!.worktreePath, 'a.txt'), 'utf8'), '1\n');
    assert.equal((await fixture.git(['diff', '--name-only'])).trim(), 'b.txt');
    const second = app.taskService.createTask({ title: 'Approved integration still protects edits' });
    app.taskService.attachPlan({ id: second.id, planContent: '1. Change a.txt to 1. Preserve b.txt.', actor: 'agent' });
    const automatic = app.automationService.enqueue(second.id,
      { ...app.automationService.settings(), mergePolicy: 'local' }, false);
    await worker.tick();
    assert.equal(app.automationService.detail(automatic.id).run.status, 'review');
    app.automationService.reviewTask(second.id, 'accept');
    await worker.tick();
    assert.match(app.automationService.detail(automatic.id).run.summary, /Target checkout must be clean/);
    assert.equal(await fs.readFile(path.join(fixture.repository, 'b.txt'), 'utf8'), 'user change\n');
  } finally { app.close(); await fixture.dispose(); }
});
