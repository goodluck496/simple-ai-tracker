/** Explicit opt-in: invokes the user's real Antigravity account once, never part of npm test. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitFixture } from '../server/src/automation/worker/testing/git-fixture.js';
import { createContainer } from '../server/src/bootstrap/container.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { TrackerToolRegistry } from '../server/src/mcp/tools.js';
import { PipelineWorker } from '../server/src/automation/worker/pipeline-worker.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { AutomationTool } from '../shared/automation/protocol.js';

if (process.env.SAT_LIVE_ANTIGRAVITY !== '1') throw new Error('Set SAT_LIVE_ANTIGRAVITY=1 to authorize one real CLI invocation.');
const fixture = await gitFixture();
const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
const resumeTest = process.env.SAT_LIVE_RESUME === '1';
let passed = false;
try {
  await fs.writeFile(path.join(fixture.repository, 'AGENTS.md'), 'Follow the assigned work order. No CodeGraph index exists here. Read only the named files, patch a.txt, and run the named focused check. Never print file bodies or source code. Runtime .sat checkpoints are permitted. Do not change branches or create commits.');
  await fs.writeFile(path.join(fixture.repository, 'check.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8').trim(),'1'); console.log('PASS: answer is 1');");
  await fixture.git(['add', 'AGENTS.md', 'check.cjs']); await fixture.git(['commit', '-m', 'fixture instructions and check']);
  app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: fixture.repository, baseBranch: 'master',
    maxAgentCalls: resumeTest ? 2 : 1, maxRunMinutes: 10, maxInputTokens: 200000, maxStageToolCalls: 24,
    connections: [{ id: 'n', label: 'Antigravity live fixture', kind: 'native', nativeRunner: 'antigravity', supportsImages: false }],
    agents: [{ id: 'developer', role: 'developer', runner: 'antigravity', model: process.env.SAT_LIVE_MODEL ?? 'gemini-3.8-flash-medium', connectionId: 'n', instructions: 'Complete only the three tiny plan steps. Save at least one meaningful stage-note before editing. No extra research. Return the required JSON outcome.' }],
    pipeline: ['developer'], setup: [], checks: [{ command: process.execPath, args: ['check.cjs'] }] });
  const task = app.taskService.createTask({ title: 'Antigravity worker checkpoint acceptance fixture', description: 'Change a.txt from 0 to 1. Preserve b.txt. Save short prose checkpoints into the assigned card through the worker mailbox. No code in notes. Use current worktree files.' });
  app.taskService.attachPlan({ id: task.id, planContent: '# Plan\n1. Read AGENTS.md, .sat/stage-context.json and a.txt. Write a factual checkpoint with the current key, findings and nextStep.\n2. Patch a.txt to contain 1. Preserve b.txt.\n3. Run node check.cjs. Save a checkpoint with the command result and return pass with a valid Russian commitMessage for this task.', actor: 'agent' });
  const run = app.automationService.enqueue(task.id);
  const registry = new TrackerToolRegistry(app);
  let stopAfterCheckpoint = resumeTest;
  let worker: PipelineWorker;
  const channel = { workspace: 'default', async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await registry.call(name, args);
    const text = response.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
    if (response.isError) throw new Error(text);
    if (name === AutomationTool.Progress) console.log(String((args as Record<string, unknown>).text ?? '').slice(0, 1000));
    if (name === AutomationTool.Checkpoint) {
      console.log('CHECKPOINT accepted by tracker MCP');
      if (stopAfterCheckpoint && (args.result as { note?: unknown })?.note) {
        stopAfterCheckpoint = false;
        worker.stop(); console.log('Controlled interruption after durable task checkpoint');
      }
    }
    return JSON.parse(text) as T;
  } };
  worker = new PipelineWorker(channel, 'antigravity-live-fixture', fixture.executor);
  await worker.tick();
  let resumedSession: string | undefined;
  if (resumeTest) {
    const interrupted = app.automationService.detail(run.id).run;
    assert.equal(interrupted.status, 'failed');
    assert.ok(interrupted.stageMemory?.note); resumedSession = interrupted.stageMemory.conversationId;
    assert.ok(resumedSession);
    app.automationService.resume(run.id);
    worker = new PipelineWorker(channel, 'antigravity-resume-fixture', fixture.executor);
    await worker.tick();
  }
  const detail = app.automationService.detail(run.id);
  const checkpoints = detail.events.filter(event => event.kind === 'checkpoint').length;
  const report = { status: detail.run.status, summary: detail.run.summary, stage: detail.run.stage, checkpoints,
    sessionSaved: !!detail.run.stageMemory?.conversationId, resumeVerified: resumeTest && resumedSession === detail.run.stageMemory?.conversationId, note: detail.run.stageMemory?.note,
    usage: detail.run.usageAttempts, worktree: detail.run.checkout?.worktreePath, root: fixture.root };
  await fs.mkdir('dist/acceptance', { recursive: true });
  await fs.writeFile('dist/acceptance/antigravity-worker.json', JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
  assert.equal(detail.run.status, 'review'); assert.ok(checkpoints > 0); assert.ok(report.sessionSaved);
  assert.equal(detail.run.usageAttempts!.at(-1)!.finished, true, 'Final aggregate must be saved as a completed attempt');
  if (resumeTest) assert.equal(report.resumeVerified, true);
  assert.equal((await fs.readFile(path.join(detail.run.checkout!.worktreePath, 'a.txt'), 'utf8')).trim(), '1');
  assert.equal((await fs.readFile(path.join(fixture.repository, 'a.txt'), 'utf8')).trim(), '0');
  passed = true;
  console.log('PASS: real Antigravity through PipelineWorker, isolated patch, actual check, structured outcome, task checkpoint and saved conversation. ' + (resumeTest ? 'Controlled interruption and same-conversation resume.' : 'One model invocation.'));
} finally {
  app.close();
  if (passed) await fixture.dispose();
  else console.log('Preserved failed fixture worktree for inspection: ' + fixture.root);
}
