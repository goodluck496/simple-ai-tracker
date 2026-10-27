import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { TrackerToolRegistry } from '../../mcp/tools.js';
import { PipelineWorker } from './pipeline-worker.js';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../../shared/automation/contracts.js';
import { StageCheckpoint } from './stage-checkpoint.js';
import { WorktreePreparation } from './worktree-preparation.js';

test('worker runs isolated Git pipeline, executes real checks, fixes review findings and fast-forwards without marking done', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-pipeline-'));
  const repo = path.join(root, 'project with spaces');
  await mkdir(repo);
  const executor = new ProcessExecutor();
  const git = (args: string[]) => executor.run({ command: 'git', args, cwd: repo, signal: AbortSignal.timeout(30000) });
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['config', 'user.name', 'Tracker fixture']);
    await writeFile(path.join(repo, 'answer.txt'), '0', 'utf8');
    await git(['add', '.']); await git(['commit', '-m', 'initial fixture']);
    const bridge = path.join(root, 'fixture-agent.cjs');
    await writeFile(bridge, `const fs=require('node:fs'); const role=process.argv[2]; let verdict='pass'; let plan;
if(role==='analyst') plan='# Plan\\nUpdate answer and verify it.';
if(role==='developer') fs.writeFileSync('answer.txt',String(Number(fs.readFileSync('answer.txt','utf8'))+1));
if(role==='reviewer' && fs.readFileSync('answer.txt','utf8')!=='2') verdict='changes_requested';
process.stdout.write(JSON.stringify({verdict,summary:role+': '+verdict,plan,commitMessage:'[#SAT-1] - Изменено значение ответа, чтобы проверить ожидаемое поведение'}));`, 'utf8');
    const roles = ['analyst', 'developer', 'tester', 'reviewer'] as const;
    const settings: AutomationSettings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: repo, mergePolicy: 'local',
      connections: [{ id: 'fixture', label: 'Deterministic fixture', kind: 'native', supportsImages: false }],
      agents: roles.map((role) => ({ id: role, role, runner: 'custom', connectionId: 'fixture', model: 'fixture-only', instructions: '', command: process.execPath, args: [bridge, '{role}'] })),
      pipeline: [...roles], checks: [{ command: process.execPath, args: ['-e', "require('node:assert').ok(Number(require('node:fs').readFileSync('answer.txt','utf8'))>0)"] }] };
    app.automationService.configure({ ...settings, maxAgentCalls: 10 });
    const task = app.taskService.createTask({ title: 'Implement fixture answer' });
    const run = app.automationService.enqueue(task.id);
    const registry = new TrackerToolRegistry(app);
    const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      const result = await registry.call(name, args);
      const text = result.content.filter((item) => item.type === 'text').map((item) => item.type === 'text' ? item.text : '').join('');
      if (result.isError) throw new Error(text);
      return JSON.parse(text) as T;
    } }, 'fixture-worker', executor);
    assert.equal(await worker.tick(), true);
    const detail = app.automationService.detail(run.id);
    assert.equal(detail.run.status, 'merged', detail.run.summary);
    assert.equal(detail.run.revision, 1);
    assert.equal(detail.run.usageAttempts!.length, 7, 'Every role invocation, including revisions, retains its own token attempt');
    assert.ok(detail.run.usageAttempts!.every((attempt) => attempt.finished && !attempt.usage), 'Custom CLI output without usage remains unknown');
    assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
    assert.equal(await readFile(path.join(repo, 'answer.txt'), 'utf8'), '2');
    assert.equal((await git(['log', '--format=%s', '-1'])).trim(), '[#SAT-1] - Изменено значение ответа, чтобы проверить ожидаемое поведение');
    assert.equal((await git(['rev-list', '--count', 'HEAD'])).trim(), '2', 'One squash commit in target');
    assert.equal((await git(['rev-list', '--count', `sat/${run.id}`])).trim(), '3', 'Private source commits remain available');
    assert.equal((await git(['status', '--porcelain'])).trim(), '');
    assert.equal(await worker.tick(), false);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test('process executor terminates on cancellation and preserves Unicode argv', async () => {
  const executor = new ProcessExecutor();
  const value = 'Привет, мир & $()';
  const output = await executor.run({ command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', value], cwd: os.tmpdir(), signal: AbortSignal.timeout(5000) });
  assert.equal(output, value);
  await assert.rejects(executor.run({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: os.tmpdir(), signal: AbortSignal.timeout(100) }), /cancelled|timed out/);
});

test('worker retries commit and tester acknowledgement without recalling agents or repeating successful checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-checkpoint-'));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  class FlakyExecutor extends ProcessExecutor {
    public failCommit = true;
    public override run(request: ProcessRequest): Promise<string> {
      if (this.failCommit && request.command === 'git' && request.args[0] === 'commit' && request.cwd.includes('.sat-worktrees')) {
        this.failCommit = false; return Promise.reject(new Error('fixture transient commit failure'));
      }
      return super.run(request);
    }
  }
  const executor = new FlakyExecutor();
  const signal = AbortSignal.timeout(60000);
  const git = (args: string[], cwd = repo) => executor.run({ command: 'git', args, cwd, signal });
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    await git(['init', '-b', 'main']); await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'user.name', 'Fixture']);
    await writeFile(path.join(repo, '.gitignore'), '.sat/\nnode_modules/\n');
    await writeFile(path.join(repo, 'answer.txt'), '0');
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { 'fixture-dependency': '1.0.0' } }));
    await git(['add', '.']); await git(['commit', '-m', 'fixture']);
    const bridge = path.join(root, 'agent.cjs'); const counts = path.join(root, 'calls.json'); const setupCount = path.join(root, 'setup-count.txt');
    const checkCount = path.join(root, 'checks.txt'); const setup = path.join(root, 'setup.cjs');
    await writeFile(setup, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(setupCount)},'prepared');fs.mkdirSync('node_modules/fixture-dependency',{recursive:true});fs.writeFileSync('node_modules/fixture-dependency/package.json',JSON.stringify({main:'index.js'}));fs.writeFileSync('node_modules/fixture-dependency/index.js','module.exports=1');`);
    await writeFile(bridge, `const fs=require('node:fs');const role=process.argv[2],file=${JSON.stringify(counts)};const n=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};n[role]=(n[role]||0)+1;fs.writeFileSync(file,JSON.stringify(n));if(role==='developer')fs.writeFileSync('answer.txt','1');console.log(JSON.stringify({verdict:'pass',summary:role+' fixture passed',commitMessage:'developer stage'}));`);
    const roles = ['developer', 'tester', 'reviewer'] as const;
    const settings: AutomationSettings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: repo,
      connections: [{ id: 'fixture', label: 'fixture', kind: 'native', supportsImages: false }],
      agents: roles.map((role) => ({ id: role, role, runner: 'custom', connectionId: 'fixture', model: 'fixture', instructions: '', command: process.execPath, args: [bridge, '{role}'] })),
      pipeline: [...roles], setup: [{ command: process.execPath, args: [setup] }],
      checks: [{ command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(checkCount)},'checked\\n')`] }] };
    app.automationService.configure(settings);
    const task = app.taskService.createTask({ title: 'Resumable fixture' });
    const registry = new TrackerToolRegistry(app);
    assert.equal((await registry.call('tracker_attach_plan', { id: task.id, planContent: '# Fixture plan' })).isError, undefined);
    const run = app.automationService.enqueue(task.id); let failAcknowledgement = true;
    const worker = new PipelineWorker({ async call<T>(name: string, args = {}): Promise<T> {
      if (name === 'tracker_automation_complete_stage' && app.automationService.detail(run.id).run.stage === 1 && failAcknowledgement) {
        failAcknowledgement = false; throw new Error('fixture transient acknowledgement failure');
      }
      const result = await registry.call(name, args);
      const text = result.content.filter((item) => item.type === 'text').map((item) => item.type === 'text' ? item.text : '').join('');
      if (result.isError) throw new Error(text); return JSON.parse(text) as T;
    } }, 'fixture-worker', executor);
    await worker.tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'failed');
    assert.match(app.automationService.detail(run.id).run.summary!, /Commit message rejected/);
    const cwd = app.automationService.detail(run.id).run.checkout!.worktreePath;
    assert.equal(await readFile(path.join(cwd, 'answer.txt'), 'utf8'), '1');
    assert.equal((await git(['rev-parse', 'HEAD'], cwd)).trim(), (await git(['rev-parse', 'HEAD'], repo)).trim());
    const savedPath = path.join(cwd, '.sat', 'stage-0-0.json');
    const completed = JSON.parse(await readFile(savedPath, 'utf8'));
    completed.outcome.commitMessage = '[#SAT-1] - Изменено значение ответа, чтобы проверить восстановление этапа';
    await writeFile(savedPath, JSON.stringify(completed), 'utf8');
    app.automationService.resume(run.id); await worker.tick();
    assert.match(app.automationService.detail(run.id).run.summary!, /transient commit/);
    app.automationService.resume(run.id); await worker.tick();
    assert.equal(app.automationService.detail(run.id).run.status, 'failed');
    assert.equal(app.automationService.detail(run.id).run.stage, 1);
    app.automationService.resume(run.id); await worker.tick();
    const detail = app.automationService.detail(run.id);
    assert.equal(detail.run.status, 'review', detail.run.summary);
    assert.deepEqual(JSON.parse(await readFile(counts, 'utf8')), { developer: 1, tester: 1, reviewer: 1 });
    assert.equal(detail.run.usageAttempts!.length, 3);
    assert.equal(await readFile(checkCount, 'utf8'), 'checked\n');
    assert.equal(await readFile(setupCount, 'utf8'), 'prepared');
    assert.equal((await git(['ls-files', '--', '.sat'], cwd)).trim(), '');
    assert.equal((await git(['status', '--porcelain'], cwd)).trim(), '');
    const checkpoint = new StageCheckpoint(cwd, 99, 0, (args) => git(args, cwd));
    const record = { key: 'context-a', head: '', fingerprint: '', priorHead: '', priorStatus: '', outcome: { verdict: 'pass' as const, summary: 'fixture' } };
    await checkpoint.save(record);
    assert.equal((await checkpoint.load('context-a'))?.outcome.summary, 'fixture');
    assert.equal(await checkpoint.load('changed-context'), undefined);
    await writeFile(path.join(cwd, 'answer.txt'), 'user change');
    await assert.rejects(checkpoint.load('context-a'), /no longer matches/);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test('preparation repairs an interrupted npm installation even with an existing setup marker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-npm-'));
  const signal = AbortSignal.timeout(30000); let installs = 0; let failInstall = true;
  class NpmFixture extends ProcessExecutor {
    public override async run(request: ProcessRequest): Promise<string> {
      if (request.command !== 'npm') return super.run(request);
      assert.equal(request.args[0], 'ci'); installs++;
      if (failInstall) { failInstall = false; throw new Error('fixture setup unavailable'); }
      const dependency = path.join(root, 'node_modules', 'fixture-dependency'); await mkdir(dependency, { recursive: true });
      await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ main: 'index.js' }));
      await writeFile(path.join(dependency, 'index.js'), 'module.exports=1'); return '';
    }
  }
  const executor = new NpmFixture();
  try {
    await executor.run({ command: 'git', args: ['init'], cwd: root, signal });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'fixture-dependency': '1.0.0' } }));
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    const preparation = new WorktreePreparation(executor);
    await assert.rejects(preparation.prepare(root, [], signal, () => {}), /fixture setup unavailable/);
    await assert.rejects(readFile(path.join(root, '.sat', 'setup-complete')), /ENOENT/);
    await preparation.prepare(root, [], signal, () => {}); assert.equal(installs, 2);
    await preparation.prepare(root, [], signal, () => {}); assert.equal(installs, 2);
    await rm(path.join(root, 'node_modules', 'fixture-dependency', 'index.js'));
    await preparation.prepare(root, [], signal, () => {}); assert.equal(installs, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
