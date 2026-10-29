import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitFixture } from './testing/git-fixture.js';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { PipelineWorker } from './pipeline-worker.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';

test('worker publishes partial notes before crash, resumes same stage conversation and isolates later roles', async () => {
  const fixture = await gitFixture();
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  const tools = new TrackerToolRegistry(app); let calls = 0;
  try {
    app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: fixture.repository, baseBranch: 'master',
      connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
      agents: (['analyst', 'developer', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'antigravity', model: 'fixture', connectionId: 'n', instructions: '' })),
      pipeline: ['analyst', 'developer', 'reviewer'], checks: [{ command: process.execPath, args: ['--version'] }] });
    const task = app.taskService.createTask({ title: 'Resume fixture' });
    const run = app.automationService.enqueue(task.id);
    class Runners extends AgentRunnerRegistry {
      public override get() { return { id: 'antigravity' as const, async run(job: AgentJob) {
        calls++;
        const context = JSON.parse(await fs.readFile(path.join(job.cwd, '.sat/stage-context.json'), 'utf8'));
        if (calls === 1) {
          assert.equal(job.sessionId, undefined); job.onSession?.('analyst-session');
          job.onUsage?.({ inputTokens: 25, outputTokens: 4, cachedInputTokens: 10, source: 'antigravity-json', reportedRequests: 1, missingRequests: 0 }, { terminal: false });
          await fs.writeFile(path.join(job.cwd, '.sat/stage-note.json'), JSON.stringify({ key: context.key,
            note: { summary: 'Локализован путь изменения ответа', files: ['a.txt'], nextStep: 'Сформировать план изменения ответа' } }));
          throw new Error('simulated CLI interruption');
        }
        if (job.profile.role === 'analyst') {
          assert.equal(job.sessionId, 'analyst-session');
          assert.equal(job.sessionUsage?.inputTokens, 25, 'Resume receives prior usage only from its conversation');
          assert.match(job.prompt, /Локализован путь изменения ответа/);
          assert.equal(context.currentNote.summary, 'Локализован путь изменения ответа');
          return { text: JSON.stringify({ verdict: 'pass', summary: 'Plan ready', plan: '# Plan\n1. Update a.txt and run focused check.' }) };
        }
        assert.equal(job.sessionId, undefined, 'Later roles have independent conversations');
        if (job.profile.role === 'developer') await fs.writeFile(path.join(job.cwd, 'a.txt'), 'updated\n');
        return { text: JSON.stringify({ verdict: 'pass', summary: 'Stage complete', commitMessage: `[#${task.id}] - Изменён ответ, чтобы проверить сохранение этапов` }) };
      } }; }
    }
    const worker = () => new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await tools.call(name, args);
      const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } }, 'resume-fixture', fixture.executor, new Runners());
    await worker().tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'failed');
    const memory = app.automationService.detail(run.id).run.stageMemory!;
    assert.equal(memory.conversationId, 'analyst-session'); assert.ok(memory.note);
    assert.equal(app.automationService.detail(run.id).events.filter(e => e.kind === 'checkpoint').length, 1);
    app.automationService.resume(run.id); await worker().tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'review');
    assert.equal(calls, 4);
    assert.equal(app.automationService.detail(run.id).events.filter(e => e.kind === 'checkpoint').length, 1, 'No replay duplicates');
  } finally { app.close(); await fixture.dispose(); }
});
