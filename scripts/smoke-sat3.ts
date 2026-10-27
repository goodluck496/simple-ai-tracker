import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createContainer } from '../server/src/bootstrap/container.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { TrackerToolRegistry } from '../server/src/mcp/tools.js';
import { PipelineWorker } from '../server/src/automation/worker/pipeline-worker.js';
import { AgentRunnerRegistry } from '../server/src/automation/runners/registry.js';
import { ProcessExecutor } from '../server/src/automation/runners/process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob, type RunnerId } from '../shared/automation/contracts.js';
import { AutomationTool } from '../shared/automation/protocol.js';
import { RunPreparation } from '../server/src/automation/worker/run-preparation.js';
import { RunWorkspace } from '../server/src/automation/worker/run-workspace.js';
import { DependencyPool } from '../server/src/automation/worker/dependency-pool.js';

// Opt-in acceptance only: models mode consumes the selected Codex account allowance.
const mode = process.argv[2];
const executor = new ProcessExecutor();
const signal = AbortSignal.timeout(mode?.startsWith('dependencies') ? 12 * 60000 : 8 * 60000);
const run = (cwd: string, command: string, args: string[]) => executor.run({ cwd, command, args, signal, maxOutputChars: 3000 });
const git = (cwd: string, args: string[]) => run(cwd, 'git', args);
const fixtureApp = (root: string, clock?: { now(): string }) => createContainer({ config: { appRoot: path.join(root, 'tracker'), dbPath: path.join(root, 'tracker', 'data', 'tracker.db') }, logger: new SilentLogger(), ...(clock ? { clock } : {}) });
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const report = (value: unknown) => console.log(JSON.stringify(value));

if (mode === 'worker') {
  const root = await fs.realpath(process.argv[3]);
  assert.ok(path.basename(root).startsWith('sat3-acceptance-'));
  const resume = process.argv[4] === 'resume';
  const app = fixtureApp(root); const registry = new TrackerToolRegistry(app);
  class RecordingRegistry extends AgentRunnerRegistry {
    public override get(id: RunnerId) {
      const native = super.get(id);
      return { id, async run(job: AgentJob, progress: (text: string) => void) {
        const entry = { pid: process.pid, at: Date.now(), cwd: job.cwd, role: job.profile.role, resolver: job.prompt.startsWith('Resolve only') };
        await fs.appendFile(path.join(root, `calls-${process.pid}.jsonl`), JSON.stringify(entry) + '\n');
        return native.run(job, progress);
      } };
    }
  }
  let first = true;
  const channel = { async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!resume && name === AutomationTool.BeginStage && first) {
      first = false;
      await fs.writeFile(path.join(root, `ready-${String(args.id)}`), String(process.pid));
      const deadline = Date.now() + 60000;
      while ((await fs.readdir(root)).filter(name => name.startsWith('ready-')).length < 2) {
        if (Date.now() > deadline) throw new Error('Second worker never reached the concurrency barrier');
        await delay(100);
      }
    }
    if (!resume && name === AutomationTool.Merged) {
      const marker = path.join(root, 'publication-crash.json');
      try {
        await fs.writeFile(marker, JSON.stringify({ id: args.id, pid: process.pid }), { flag: 'wx' });
        process.exit(73); // Genuine process death after Git publication, before tracker acknowledgement.
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const result = await registry.call(name, args);
    const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('');
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  } };
  try { await new PipelineWorker(channel, `acceptance-${process.pid}`, executor, new RecordingRegistry()).tick(); }
  finally { app.close(); }
} else if (mode === 'models') {
  const model = process.argv[3] ?? 'gpt-6-luna';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat3-acceptance-'));
  report({ mode, root, model });
  const repository = path.join(root, 'project'); await fs.mkdir(repository);
  await git(repository, ['init', '-b', 'master']);
  await git(repository, ['config', 'user.name', 'SAT acceptance']);
  await git(repository, ['config', 'user.email', 'acceptance@example.invalid']);
  await git(repository, ['config', 'commit.gpgsign', 'false']);
  await git(repository, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repository, 'values.json'), '{"a":0,"b":0}\n');
  await fs.writeFile(path.join(repository, 'check.cjs'), "const assert=require('node:assert/strict');const v=require('./values.json');assert.deepEqual(Object.keys(v).sort(),['a','b']);for(const x of Object.values(v))assert.ok(x===0||x===1);assert.ok(v.a+v.b>=1);\n");
  await fs.writeFile(path.join(repository, 'AGENTS.md'), 'Acceptance fixture. Edit values.json only; retain a one-line JSON object. Preserve both independent task requirements when merging. Never access external services or tracker tools. Do not commit, stage, switch branches, or install dependencies. check.cjs is already provided; do not change it.\n');
  await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'acceptance base']);
  const app = fixtureApp(root);
  const settings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: repository, baseBranch: 'master', mergePolicy: 'local' as const,
    maxParallelRuns: 2, maxRunMinutes: 6, timeoutMinutes: 6, maxAgentCalls: 4, maxInputTokens: 180000, maxRevisions: 0,
    maxResolverCalls: 1, resolverTimeoutMinutes: 2, maxResolverToolCalls: 12,
    connections: [{ id: 'native', label: 'Acceptance Codex', kind: 'native' as const, supportsImages: false }],
    agents: (['developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'codex' as const, connectionId: 'native', model,
      args: ['-c', 'model_reasoning_effort="low"'], instructions: 'Tiny acceptance fixture: follow the supplied plan exactly, inspect only the listed files, run node check.cjs once when useful, return concise JSON. No exploration, new tests, extra files, tracker queries, or unrelated changes.' })),
    pipeline: ['developer', 'tester', 'reviewer'], checks: [{ command: process.execPath, args: ['check.cjs'] }] };
  app.automationService.configure(settings);
  const ids = ['a', 'b'].map(key => {
    const other = key === 'a' ? 'b' : 'a';
    const task = app.taskService.createTask({ title: `Set ${key} to 1`, description: `In YOUR SOURCE BRANCH set ONLY key ${key} in values.json to 1. The other key ${other} MUST remain exactly its current value (0 on the initial source branch). Do not implement concurrent tasks. The conflict resolver later combines independent tasks on master, where both a=1,b=1 are required. Existing check.cjs is sufficient; do not modify it.` });
    app.taskService.attachPlan({ id: task.id, planContent: `# Plan\nSource branch: change only values.json, set ${key}=1, leave ${other}=0. Keep one-line JSON. Run node check.cjs. Only during INTEGRATION combine both independent requirements, preserving target values: a=1,b=1.`, actor: 'agent' });
    return app.automationService.enqueue(task.id).id;
  });
  app.close();
  const args = ['--import', 'tsx', import.meta.filename, 'worker', root];
  const workers = await Promise.allSettled([run(process.cwd(), process.execPath, args), run(process.cwd(), process.execPath, args)]);
  report({ workers: workers.map(r => r.status === 'fulfilled' ? r.value.slice(-1200) || 'exited' : String(r.reason).slice(-700)) });
  const inspection = fixtureApp(root);
  try { report({ runs: inspection.automationService.list().map(r => ({ id: r.id, status: r.status, summary: r.summary.slice(-2400) })) }); }
  finally { inspection.close(); }
  const calls = async () => (await Promise.all((await fs.readdir(root)).filter(n => /^calls-\d+\.jsonl$/.test(n)).map(async n => (await fs.readFile(path.join(root, n), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)))).flat();
    const before = await calls();
  const crashed = await json(path.join(root, 'publication-crash.json'));
  // Advance only the synthetic tracker clock to expire the dead process' lease; no 90-second sleep.
  const recovery = fixtureApp(root, { now: () => new Date(Date.now() + 120000).toISOString() });
  recovery.automationService.list();
  const blocked = recovery.automationService.detail(crashed.id).run;
  assert.equal(blocked.status, 'merge_blocked');
  recovery.automationService.resume(crashed.id); recovery.close();
  const count = (await git(repository, ['rev-list', '--count', 'master'])).trim();
  await run(process.cwd(), process.execPath, [...args.slice(0, -1), root, 'resume']);
  const final = fixtureApp(root);
  try {
    const results = ids.map(id => final.automationService.detail(id).run);
    assert.ok(results.every(r => r.status === 'merged'), JSON.stringify(results.map(r => ({ status: r.status, summary: r.summary }))));
    assert.notEqual(results[0].checkout!.worktreePath, results[1].checkout!.worktreePath);
    assert.equal(results[0].checkout!.baseSha, results[1].checkout!.baseSha);
    assert.deepEqual(await json(path.join(repository, 'values.json')), { a: 1, b: 1 });
    assert.equal((await git(repository, ['rev-list', '--count', 'master'])).trim(), '3');
    assert.equal(count, '3');
    assert.equal((await calls()).length, before.length, 'Restart must not invoke any agent');
    assert.equal(before.filter(c => c.resolver).length, 1);
    assert.equal(new Set(before.filter(c => !c.resolver).map(c => c.pid)).size, 2);
    assert.equal((await git(repository, ['status', '--porcelain'])).trim(), '');
    report({ pass: true, scenario: 'two real worker processes + native agents + real conflict + squash + process-death recovery',
      modelCalls: before.length, resolvers: before.filter(c => c.resolver).length, commits: 3,
      runs: results.map(r => ({ id: r.id, status: r.status, source: r.commitSha, candidate: r.integration?.candidateSha, tokens: r.usageAttempts?.reduce((sum, a) => sum + (a.usage?.inputTokens ?? 0), 0) })) });
  } finally { final.close(); }
  // Preserve acceptance evidence/worktrees. Never recursively remove linked dependencies here.
} else if (mode === 'models-finish') {
  const root = await fs.realpath(process.argv[3]);
  assert.ok(path.basename(root).startsWith('sat3-acceptance-'));
  const app = fixtureApp(root); let retry: string;
  try {
    const blocked = app.automationService.list().find(r => r.status === 'merge_blocked');
    assert.ok(blocked, 'Expected preserved blocked integration');
    assert.equal(blocked.stage, blocked.settings.pipeline.length);
    retry = app.automationService.restart(blocked.id).id;
  } finally { app.close(); }
  await run(process.cwd(), process.execPath, ['--import', 'tsx', import.meta.filename, 'worker', root, 'resume']);
  const final = fixtureApp(root);
  try {
    const runs = final.automationService.list(); const result = final.automationService.detail(retry!).run;
    assert.equal(result.status, 'merged', result.summary);
    assert.equal(result.usageAttempts?.filter(a => a.kind !== 'resolver').length, 0, 'Integration-only restart must not replay roles');
    assert.equal(result.usageAttempts?.filter(a => a.kind === 'resolver').length, 1);
    const repository = path.join(root, 'project');
    assert.deepEqual(await json(path.join(repository, 'values.json')), { a: 1, b: 1 });
    assert.equal((await git(repository, ['rev-list', '--count', 'master'])).trim(), '3');
    assert.equal((await git(repository, ['status', '--porcelain'])).trim(), '');
    report({ pass: true, scenario: 'real conflict resolver + guarded extra-file rejection + explicit integration-only recovery; process-death publication recovered without duplicate',
      root, runs: runs.map(r => ({ id: r.id, status: r.status, stage: r.stage, calls: r.usageAttempts?.length, inputTokens: r.usageAttempts?.reduce((sum, a) => sum + (a.usage?.inputTokens ?? 0), 0) })) });
  } finally { final.close(); }
} else if (mode === 'inspect') {
  const root = await fs.realpath(process.argv[3]);
  assert.ok(path.basename(root).startsWith('sat3-acceptance-'));
  const app = fixtureApp(root);
  try { report(app.automationService.list().map(r => ({ id: r.id, status: r.status, summary: r.summary, calls: r.usageAttempts?.length,
    inputTokens: r.usageAttempts?.reduce((sum, a) => sum + (a.usage?.inputTokens ?? 0), 0),
    cachedTokens: r.usageAttempts?.reduce((sum, a) => sum + (a.usage?.cachedInputTokens ?? 0), 0),
    outputTokens: r.usageAttempts?.reduce((sum, a) => sum + (a.usage?.outputTokens ?? 0), 0) })) ); }
  finally { app.close(); }
} else if (mode === 'dependencies-finish') {
  const root = await fs.realpath(process.argv[3]);
  assert.ok(path.basename(root).startsWith('sat3-angular-'));
  const repository = path.join(root, 'project'); const common = await fs.realpath(path.join(repository, '.git'));
  const folders = [path.join(root, 'one'), path.join(root, 'two')];
  assert.equal((await json(path.join(folders[0], 'package-lock.json'))).acceptance, 'changed');
  const preparation = new RunPreparation(executor, common, { ...DEFAULT_AUTOMATION_SETTINGS, dependencyMode: 'linked' });
  let key: string | undefined;
  try {
    const second = await preparation.prepare(folders[1], signal, () => {}); key = second.key;
    assert.equal(second.mode, 'linked');
    // Complete the private install interrupted by the acceptance harness deadline.
    if (process.argv[4] !== '--built') await run(folders[0], 'npm', ['ci', '--include=dev', '--no-audit', '--no-fund']);
    assert.equal((await preparation.prepare(folders[0], signal, () => {})).mode, 'isolated');
    assert.notEqual(await fs.realpath(path.join(folders[0], 'node_modules', '@angular', 'core')), await fs.realpath(path.join(folders[1], 'node_modules', '@angular', 'core')));
    if (process.argv[4] !== '--built') await Promise.all(folders.map(cwd => run(cwd, 'npm', ['run', 'build'])));
    for (const cwd of folders) { await fs.access(path.join(cwd, 'dist', 'server', 'api.mjs')); await fs.access(path.join(cwd, 'dist', 'web', 'browser', 'index.html')); }
    await fs.mkdir(path.join(folders[0], 'node_modules', '.cache'), { recursive: true });
    await fs.writeFile(path.join(folders[0], 'node_modules', '.cache', 'only-one'), 'local');
    await assert.rejects(fs.access(path.join(folders[1], 'node_modules', '.cache', 'only-one')));
    await assert.rejects(fs.writeFile(path.join(folders[1], 'node_modules', '@angular', 'core', 'package.json'), '{}'), /EPERM|EACCES|EROFS/);
    report({ pass: true, scenario: 'resumed actual Angular/server acceptance: private changed-lock checkout and immutable shared checkout build concurrently', root, key });
    for (const cwd of folders) await preparation.detach(cwd);
    const cache = new DependencyPool(common, executor);
    try { await cache.pruneUnused(key!, signal); } finally { cache.close(); }
    report({ pass: true, scenario: 'safe cache cleanup after all readers detached' });
  } finally { preparation.close(); }
} else if (mode === 'dependencies') {
  const source = path.resolve(import.meta.dirname, '..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat3-angular-'));
  report({ mode, root });
  const repository = path.join(root, 'project');
  await git(source, ['clone', '--local', '--no-hardlinks', source, repository]);
  await git(repository, ['config', 'core.autocrlf', 'false']);
  const common = await fs.realpath(path.join(repository, '.git'));
  await RunWorkspace.ignoreRuntime(common);
  const folders = [path.join(root, 'one'), path.join(root, 'two')];
  for (const cwd of folders) { await git(repository, ['worktree', 'add', '--detach', cwd, 'HEAD']); await fs.mkdir(path.join(cwd, '.sat')); }
  const preparation = new RunPreparation(executor, common, { ...DEFAULT_AUTOMATION_SETTINGS, dependencyMode: 'linked' });
  try {
    const prepared = await Promise.all(folders.map(cwd => preparation.prepare(cwd, signal, () => {})));
    report({ phase: 'dependencies-ready', modes: prepared.map(p => p.mode) });
    assert.ok(prepared.every(p => p.mode === 'linked'), JSON.stringify(prepared));
    assert.equal(prepared[0].key, prepared[1].key);
    assert.equal(await fs.realpath(path.join(folders[0], 'node_modules', '@angular', 'core')), await fs.realpath(path.join(folders[1], 'node_modules', '@angular', 'core')));
    await Promise.all(folders.map(cwd => run(cwd, 'npm', ['run', 'build'])));
    report({ phase: 'parallel-builds-passed' });
    await fs.writeFile(path.join(folders[0], 'node_modules', '.cache', 'only-one'), 'local');
    await assert.rejects(fs.access(path.join(folders[1], 'node_modules', '.cache', 'only-one')));
    await assert.rejects(fs.writeFile(path.join(folders[0], 'node_modules', '@angular', 'core', 'package.json'), '{}'), /EPERM|EACCES|EROFS/);
    // A valid lockfile metadata change forces an independent installation in the first checkout.
    const lock = await json(path.join(folders[0], 'package-lock.json')); lock.acceptance = 'changed';
    await fs.writeFile(path.join(folders[0], 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    assert.equal((await preparation.prepare(folders[0], signal, () => {})).mode, 'isolated');
    assert.notEqual(await fs.realpath(path.join(folders[0], 'node_modules', '@angular', 'core')), await fs.realpath(path.join(folders[1], 'node_modules', '@angular', 'core')));
    await Promise.all(folders.map(cwd => run(cwd, 'npm', ['run', 'build:web'])));
    for (const cwd of folders) await preparation.detach(cwd);
    const cache = new DependencyPool(common, executor);
    try { await cache.pruneUnused(prepared[0].key!, signal); } finally { cache.close(); }
    report({ pass: true, scenario: 'two real Angular/server builds, one readonly npm cache, lock-change detachment, builds after detachment', root, key: prepared[0].key });
  } finally { preparation.close(); }
} else throw new Error('Usage: npx tsx scripts/smoke-sat3.ts models [codex-model] | dependencies');
