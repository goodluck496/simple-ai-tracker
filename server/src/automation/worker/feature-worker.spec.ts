import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { AgentRunnerRegistry } from '../runners/registry.js';
import { PipelineWorker } from './pipeline-worker.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';
import { Decomposition } from '../../../../shared/automation/decomposition.js';
import { FeaturePlanning } from '../feature-planning.js';

test('decomposition rejects missing plans, unknown dependencies, duplicates and cycles', () => {
  const a = { key: 'A', title: 'A', description: 'First', plan: '1. Implement A', dependsOn: [] as string[] };
  const b = { ...a, key: 'B', dependsOn: ['A'] };
  assert.deepEqual(Decomposition.validate([b, a]).map(t => t.key), ['A', 'B']);
  for (const parts of [[a], [a, a], [a, { ...b, plan: '' }], [a, { ...b, dependsOn: ['missing'] }], [{ ...a, dependsOn: ['B'] }, b]]) assert.throws(() => Decomposition.validate(parts));
  assert.throws(() => Decomposition.validate(Array.from({ length: 13 }, (_, i) => ({ ...a, key: `T${i}` }))));
});

test('feature asks before dispatch, resumes legacy budget checkpoint automatically and reviews isolated children without recursion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-feature-'));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  const executor = new ProcessExecutor();
  const git = (args: string[], cwd = repo) => executor.run({ command: 'git', args, cwd, signal: AbortSignal.timeout(30000) });
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  let analyses = 0; let betaDevelopments = 0; let reviews = 0; let testerCalls = 0;
  const childrenDirectories = new Set<string>();
  try {
    await git(['init', '-b', 'main']); await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Fixture']);
    await writeFile(path.join(repo, 'initial.txt'), 'initial'); await git(['add', '.']); await git(['commit', '-m', 'initial']);
    const initial = (await git(['rev-parse', 'HEAD'])).trim();
    const check = path.join(root, 'check.cjs'); const checked = path.join(root, 'checked.txt');
    await writeFile(check, `const f=require('node:fs'),a=require('node:assert'); a.equal(f.readFileSync('alpha.txt','utf8'),'alpha'); a.equal(f.readFileSync('beta.txt','utf8'),'beta2'); f.appendFileSync(${JSON.stringify(checked)},'checked\\n');`);
    const roles = ['analyst', 'developer', 'tester', 'reviewer'] as const;
    app.automationService.configure({ ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: repo, baseBranch: 'main', mergePolicy: 'local',
      connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
      agents: roles.map(role => ({ id: role, role, runner: 'codex', connectionId: 'fixture', model: 'fixture', instructions: '' })), pipeline: [...roles],
      checks: [{ command: process.execPath, args: [check] }] });
    const task = app.taskService.createTask({ title: 'Combined feature', description: 'Preserve the original file and deliver alpha plus beta2.' });
    const run = app.automationService.enqueue(task.id);
    assert.throws(() => FeaturePlanning.callBudget({ ...run, settings: { ...run.settings, maxRevisions: 10,
      pipeline: ['analyst', 'developer', ...Array(40).fill('tester'), 'reviewer'] } }, { verdict: 'pass', summary: 'Oversized', decomposition: [
      { key: 'A', title: 'A', description: 'A', plan: '1. A', dependsOn: [] },
      { key: 'B', title: 'B', description: 'B', plan: '1. B', dependsOn: [] },
    ] }), /hard limit of 100/);
    class FixtureRunners extends AgentRunnerRegistry {
      public override get() { return { id: 'codex' as const, async run(job: AgentJob) {
        const order = JSON.parse(await readFile(path.join(job.cwd, '.sat', 'work-order.json'), 'utf8'));
        const child = order.task.id !== task.id;
        const role = job.profile.role;
        let verdict = 'pass'; let questions: string[] = []; let decomposition;
        if (role === 'analyst') {
          analyses++;
          decomposition = [
            { key: 'B', title: 'Beta', description: 'Implement beta.', plan: '1. Write beta.txt. Verify beta2.', dependsOn: ['A'] },
            { key: 'A', title: 'Alpha', description: 'Implement alpha.', plan: '1. Write alpha.txt. Verify alpha.', dependsOn: [] },
          ];
          if (analyses === 1) { questions = ['May beta depend on alpha?']; }
        }
        if (child) {
          assert.ok(app.automationService.activeTaskIds().includes(order.task.id), 'Child is reserved by the original feature run');
          childrenDirectories.add(job.cwd);
          assert.match(await git(['branch', '--show-current'], job.cwd), /sat-child\//);
          assert.ok(order.task.description.includes('Preserve the original file'));
          assert.ok(!order.workOrder.steps.some((s: { text: string }) => s.text.includes('Test both together')), 'Parent work order is reference context, not executable child steps');
          assert.equal((await git(['rev-parse', 'HEAD'])).trim(), initial, 'main stays untouched until aggregate checks');
          if (role === 'developer') {
            if (order.task.title === 'Alpha') await writeFile(path.join(job.cwd, 'alpha.txt'), 'alpha');
            else { betaDevelopments++; assert.equal(await readFile(path.join(job.cwd, 'alpha.txt'), 'utf8'), 'alpha'); await writeFile(path.join(job.cwd, 'beta.txt'), `beta${betaDevelopments}`); }
          } else {
            reviews++;
            if (order.task.title === 'Beta' && betaDevelopments === 1) verdict = 'changes_requested';
          }
        } else if (role === 'tester') {
          testerCalls++; assert.equal(order.featureDeliveries.length, 2);
          assert.ok(order.featureDeliveries.every((c: { state: string }) => c.state === 'merged'));
        }
        return { text: JSON.stringify({ verdict, questions, summary: `${role}: ${verdict}`, plan: role === 'analyst' ? '1. Deliver alpha then beta2; preserve initial.txt.\n2. Test both together.' : '', decomposition,
          commitMessage: `[#${order.task.id}] - Добавлены результаты работы для проверки общей фичи` }) };
      } }; }
    }
    const registry = new TrackerToolRegistry(app);
    let interruptDelivery = true;
    let legacyBudgetStop = true;
    const channel = { async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const outcome = args.outcome as { decomposition?: unknown[]; verdict?: string; questions?: string[] } | undefined;
      if (name.endsWith('complete_stage') && outcome?.decomposition?.length && outcome.verdict === 'pass' && !outcome.questions?.length && legacyBudgetStop) {
        legacyBudgetStop = false; throw new Error('Legacy budget failure: need 8 calls, allowed 6');
      }
      if (name.endsWith('complete_stage') && (args.outcome as { delivery?: unknown } | undefined)?.delivery && interruptDelivery) {
        interruptDelivery = false; throw new Error('Injected child publication acknowledgement failure');
      }
      const result = await registry.call(name, args); const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } };
    const worker = () => new PipelineWorker(channel, 'feature-fixture', executor, new FixtureRunners());
    await worker().tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'waiting');
    assert.equal(app.taskService.getTaskCard(task.id).subtasks.length, 0, 'Questions dispatch no children');
    assert.throws(() => app.automationService.resume(run.id), /questions/);
    app.taskService.answerQuestions({ id: task.id, answers: [{ questionIndex: 1, answer: 'Yes' }], actor: 'user' });
    app.automationService.resume(run.id); await worker().tick();
    const stopped = app.automationService.detail(run.id).run;
    assert.equal(stopped.status, 'failed'); assert.match(stopped.summary, /Legacy budget failure/);
    assert.equal(stopped.settings.maxAgentCalls, 6);
    assert.equal(app.taskService.getTaskCard(task.id).subtasks.length, 0);
    const diagnostic = app.taskService.createTask({ title: 'Related diagnostic only' });
    app.taskService.linkTasks(task.id, diagnostic.id, 'related');
    app.automationService.resume(run.id); await worker().tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'failed');
    assert.match(app.automationService.detail(run.id).run.summary, /acknowledgement failure/);
    app.automationService.resume(run.id); await worker().tick();
    const result = app.automationService.detail(run.id).run;
    assert.equal(result.status, 'merged', result.summary);
    assert.equal(analyses, 2, 'Automatic call budget reuses the completed analyst checkpoint');
    assert.deepEqual(result.feature!.callBudget, { planned: 8, revisions: 3, resolver: 1, limit: 12 });
    assert.equal(result.settings.maxAgentCalls, 12);
    assert.equal(result.settings.maxInputTokens, 500000); assert.equal(result.settings.maxRunMinutes, 20);
    assert.equal(result.settings.maxRevisions, 1, 'The repair count is shared by all children and stays unchanged');
    assert.equal(result.settings.pipeline.filter(id => result.settings.agents.find(a => a.id === id)?.role === 'analyst').length, 1, 'Child schedules cannot introduce recursive analysts');
    assert.equal(childrenDirectories.size, 2); assert.equal(betaDevelopments, 2); assert.equal(reviews, 3); assert.equal(testerCalls, 1);
    assert.equal(result.feature!.children.length, 2);
    for (const child of result.feature!.children) {
      assert.equal(child.state, 'merged'); assert.equal(app.taskService.getTaskCard(child.taskId).status, 'review');
      assert.match(await git(['log', '-1', '--format=%s', child.mergedSha!]), new RegExp(`\\[#${child.taskId}\\]`));
    }
    assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
    assert.equal(await readFile(path.join(repo, 'alpha.txt'), 'utf8'), 'alpha'); assert.equal(await readFile(path.join(repo, 'beta.txt'), 'utf8'), 'beta2');
    assert.equal((await git(['rev-list', '--count', `${initial}..HEAD`])).trim(), '1', 'Main receives one aggregate squash');
    assert.equal((await readFile(checked, 'utf8')).split('checked').length - 1, 2, 'Full checks only aggregate tester and final merge candidate');
    assert.equal(result.usageAttempts!.length, 10, 'All children and revisions share the original call ledger');
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
