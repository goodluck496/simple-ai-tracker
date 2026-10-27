import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WorkOrder, type StageEvidence } from '../../../shared/automation/work-order.js';
import { AgentHandoff } from '../../../shared/automation/handoff.js';
import { RunBudget } from '../../../shared/automation/budget.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentRun } from '../../../shared/automation/contracts.js';
import { StageHandoff } from './worker/stage-handoff.js';

test('ordered handoff retains every plan character and criteria once, excluding machine logs and stale checks', () => {
  const content = '# Цель\nСохранить нулевой уровень.\n1. Сделать А в a.ts\n   Проверить А.\n2. Сделать Б в b.ts\n## Ограничения\nКритерий-X: не потерять Unicode α.\n';
  const order = WorkOrder.from({ version: 3, content })!;
  assert.equal(order.steps.map(s => s.text).join(''), content);
  assert.deepEqual(order.steps.filter(s => s.kind === 'step').map(s => s.id), ['S1', 'S2']);
  const previous: StageEvidence = { stage: 1, revision: 0, role: 'developer', sha: 'a'.repeat(40), requirementsKey: 'requirements',
    verdict: 'pass', summary: 'A and B implemented', changedFiles: ['a.ts', 'b.ts'], current: false,
    checks: [{ command: 'node', args: ['check.cjs'], exitCode: 0 }] };
  const raw = AgentHandoff.forRole('tester', { id: 'fixture', description: 'Required behavior', plan: { content, version: 3 },
    questions: { answered: [{ text: 'Exact Y?', answer: 'Preserve zero' }] },
    comments: [{ author: 'AI Agent', text: 'RAW_LOG'.repeat(2000) }] }, ['a.ts'], previous);
  const packet = JSON.parse(raw);
  assert.equal(packet.workOrder.steps.map((s: { text: string }) => s.text).join(''), content);
  assert.equal(packet.task.description, 'Required behavior'); assert.equal(packet.task.questions.answered[0].answer, 'Preserve zero');
  assert.equal(packet.task.plan, undefined); assert.doesNotMatch(raw, /RAW_LOG/);
  assert.equal(raw.split('Критерий-X').length - 1, 1); assert.deepEqual(packet.previousStage.checks, []);
});

test('durable stage evidence survives a new worker, is invalidated for changed requirements and refuses corrupt data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-handoff-')); await fs.mkdir(path.join(root, '.sat'));
  try {
    const evidence: StageEvidence = { stage: 1, revision: 0, role: 'developer', sha: 'a'.repeat(40), requirementsKey: 'r1',
      verdict: 'pass', summary: 'Implemented A', changedFiles: ['a.ts'], checks: [] };
    await new StageHandoff(root, 'run-one').save(evidence);
    const reopened = new StageHandoff(root, 'run-one');
    assert.equal((await reopened.read(2, 0, 'r1', evidence.sha))!.current, true);
    assert.equal((await reopened.read(2, 0, 'r2', evidence.sha))!.current, false);
    assert.equal(await reopened.read(1, 0, 'r1', evidence.sha), undefined);
    await fs.writeFile(path.join(root, '.sat', 'work-progress.json'), JSON.stringify({ workOrderKey: 'r1', completedSteps: ['S1'], nextStep: 'S2', summary: 'A completed, continue B' }));
    assert.deepEqual(await reopened.progress('r1', ['S1', 'S2']), { state: 'hints', completedSteps: ['S1'], nextStep: 'S2', summary: 'A completed, continue B' });
    assert.equal((await reopened.progress('changed-plan', ['S1', 'S2']))!.state, 'stale');
    assert.equal((await reopened.progress('r1', ['S2']))!.state, 'unreadable');
    await assert.rejects(new StageHandoff(root, 'other-run').read(2, 0, 'r1', evidence.sha), /Invalid stage handoff/);
    await fs.writeFile(path.join(root, '.sat', 'stage-handoff.json'), '{');
    await assert.rejects(reopened.read(2, 0, 'r1', evidence.sha), /unreadable/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('budget diagnostics separate cached traffic from noncached input and preserve unknown cache data', () => {
  const attempt = { id: 'a', stage: 0, revision: 0, role: 'developer', runner: 'codex', model: 'fixture', startedAt: '', updatedAt: '', finished: false,
    usage: { inputTokens: 840101, cachedInputTokens: 778752, outputTokens: 5390, reportedRequests: 1, missingRequests: 0, source: 'codex-json' } } as const;
  const run = { settings: { ...DEFAULT_AUTOMATION_SETTINGS }, usageAttempts: [attempt] } as unknown as AgentRun;
  assert.equal(RunBudget.explain(run).nonCached, 61349); assert.equal(RunBudget.explain(run).percent, 168);
  assert.equal(RunBudget.explain(run).partial, true); assert.match(RunBudget.explain(run).advice, /оставшейся работы/);
  const unknown = structuredClone(run); delete unknown.usageAttempts![0].usage!.cachedInputTokens;
  assert.equal(RunBudget.explain(unknown).cached, undefined); assert.equal(RunBudget.explain(unknown).nonCached, undefined);
});

test('compact reporter emits one success line and retains nonzero failures with their actual assertion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-reporter-'));
  const reporter = pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/compact-test-reporter.mjs')).href;
  try {
    const file = path.join(root, 'fixture.cjs');
    const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
    await fs.writeFile(file, "const {test,describe}=require('node:test');describe('suite',()=>{test('ok',()=>{});test.skip('skipped',()=>{});});");
    const success = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], { encoding: 'utf8', timeout: 15000, env: environment });
    assert.equal(success.status, 0, success.stderr); assert.equal(success.stdout.trim().split('\n').length, 1);
    assert.match(success.stdout, /All 1 tests passed successfully \(1 skipped\)/);
    await fs.writeFile(file, "const {test}=require('node:test');test('bad',()=>require('node:assert/strict').equal('actual','EXPECTED_MARKER'));");
    const failure = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, file], { encoding: 'utf8', timeout: 15000, env: environment });
    assert.equal(failure.status, 1); assert.match(failure.stdout, /EXPECTED_MARKER/); assert.match(failure.stdout, /1 failed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
