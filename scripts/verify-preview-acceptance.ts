import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { TrackerToolRegistry } from '../server/src/mcp/tools.js';
import { gitFixture } from '../server/src/automation/worker/testing/git-fixture.js';
import { PipelineWorker } from '../server/src/automation/worker/pipeline-worker.js';
import { ProjectWorker } from '../server/src/automation/worker/project-worker.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';

const fixture = await gitFixture();
const app = createContainer({ config: { appRoot: fixture.root, dbPath: path.join(fixture.root, 'data', 'tracker.db'),
  webDistDir: path.resolve(import.meta.dirname, '../dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app);
const browser = await chromium.launch({ headless: true });
try {
  const agent = path.join(fixture.root, 'agent.cjs');
  await writeFile(agent, `require('node:fs').writeFileSync('a.txt','1\\n');console.log(JSON.stringify({verdict:'pass',summary:'Changed a.txt',commitMessage:'[#SAT-1] - Изменён ответ, чтобы проверить приёмку патча'}));`);
  app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: fixture.repository, baseBranch: 'master',
    connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
    agents: [{ id: 'dev', role: 'developer', runner: 'custom', model: 'fixture', connectionId: 'fixture', instructions: '', command: process.execPath, args: [agent] }],
    pipeline: ['dev'], checks: [{ command: process.execPath, args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('a.txt','utf8').trim(),'1')"] }] });
  const task = app.taskService.createTask({ title: 'Проверка приёмки патча' });
  app.taskService.attachPlan({ id: task.id, planContent: '1. Change a.txt to 1.', actor: 'agent' });
  const registry = new TrackerToolRegistry(app);
  let duringCandidateChecks: (() => Promise<void>) | undefined;
  const channel = { async call<T>(name: string, args = {}): Promise<T> {
    const result = await registry.call(name, { ...args, workspace: 'default' });
    const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('');
    if (result.isError) throw Error(text);
    if (name.endsWith('_integration') && (args as {result?: {state?: string}}).result?.state === 'checking') {
      await duringCandidateChecks?.();
    }
    return JSON.parse(text) as T;
  } };
  const pipeline = new PipelineWorker(channel, 'browser-integration', fixture.executor);
  const host = new ProjectWorker(channel, 'browser-host');
  const run = app.automationService.enqueue(task.id);
  await pipeline.tick();
  const reviewed = app.automationService.detail(run.id).run;
  assert.equal(reviewed.status, 'review', reviewed.summary);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port);
  const card = page.locator('[data-task-id="' + task.id + '"]').first();
  const discuss = async () => {
    if (!new URL(page.url()).pathname.includes('/item/' + task.id)) await card.click();
    await page.getByRole('tab', { name: /Обсуждение/ }).click();
  };
  await discuss();
  const apply = page.getByRole('button', { name: /Накатить патч$/ });
  const undo = page.getByRole('button', { name: /Откатить патч$/ });
  const accept = page.getByRole('button', { name: /Принять и слить$/ });
  await page.getByText('Патч не накатан', { exact: true }).waitFor();
  assert.ok(await undo.isDisabled());
  await apply.click();
  await page.getByText('Воркер накатывает патч…', { exact: true }).waitFor();
  await host.tick();
  await page.getByText('Патч накатан', { exact: true }).waitFor();
  await page.reload();
  await discuss();
  await page.getByText('Патч накатан', { exact: true }).waitFor();
  assert.ok(await apply.isDisabled());
  assert.ok(await undo.isEnabled());
  assert.ok(await accept.isEnabled());
  const file = path.join(fixture.repository, 'a.txt');
  const preview = await readFile(file, 'utf8');
  await writeFile(file, 'local change\n');
  await accept.click();
  await page.getByText('Воркер откатывает патч перед слиянием…', { exact: true }).waitFor();
  await host.tick();
  await page.getByRole('alert').filter({ hasText: 'Сохраните правки перед откатом' }).waitFor();
  assert.equal(await readFile(file, 'utf8'), 'local change\n');
  assert.equal(app.automationService.taskReviewState(task.id).acceptance, null);
  await writeFile(file, preview);
  await accept.click();
  await page.getByText('Воркер откатывает патч перед слиянием…', { exact: true }).waitFor();
  await page.reload();
  await discuss();
  await page.getByText('Воркер откатывает патч перед слиянием…', { exact: true }).waitFor();
  assert.equal(await accept.count(), 0);
  await host.tick();
  assert.equal(app.automationService.taskReviewState(task.id).acceptance?.status, 'queued');
  await page.getByText('Слияние в очереди. Ожидаем воркер.').waitFor();
  assert.equal((await fixture.git(['status','--porcelain'])).trim(), '');
  let sawChecks = false;
  duringCandidateChecks = async () => {
    await page.getByText('Пройдено проверок 0 из 1').waitFor();
    sawChecks = true;
  };
  await pipeline.tick();
  assert.ok(sawChecks);
  const merged = app.automationService.detail(run.id).run;
  assert.equal(merged.status, 'merged', merged.summary);
  await host.tick();
  assert.equal(app.automationService.list(task.id).length, 0);
  await page.getByText(/Слияние завершено в/).waitFor();
  await page.reload();
  await discuss();
  await page.getByText(/Слияние завершено в/).waitFor();
  assert.equal(await accept.count() + await undo.count() + await apply.count(), 0);
  assert.equal(app.taskService.getTaskCard(task.id).status, 'done');
  assert.equal((await readFile(path.join(fixture.repository, 'a.txt'), 'utf8')).trim(), '1');
  assert.equal((await fixture.git(['rev-list','--count',reviewed.checkout!.baseSha + '..HEAD'])).trim(), '1');
  assert.deepEqual(browserErrors, []);
  console.log('PASS: preview rollback, queued merge and archived merge result survive browser reload.');
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  app.close(); await fixture.dispose();
}
