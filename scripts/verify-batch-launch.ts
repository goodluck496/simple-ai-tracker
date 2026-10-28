import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-batch-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data/tracker.db'), webDistDir: path.resolve('dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app); const browser = await chromium.launch({ headless: true });
try {
  const settings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'n', label: 'Native', kind: 'native' as const, supportsImages: false }],
    agents: (['analyst', 'developer'] as const).map(role => ({ id: role, role, runner: 'codex' as const, connectionId: 'n', model: 'fixture', instructions: '' })),
    pipeline: ['analyst', 'developer'], checks: [] };
  app.automationService.configure(settings);
  const a = app.taskService.createTask({ title: 'First analysis' }); const b = app.taskService.createTask({ title: 'Will become blocked' });
  const c = app.taskService.createTask({ title: 'Second analysis' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const requests: { taskIds: string[]; requestId: string }[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/automation/batch')) requests.push(request.postDataJSON()); });
  await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port);
  await page.getByRole('button', { name: 'Группа задач', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Команда агентов', exact: true });
  const stages = modal.getByRole('region', { name: 'Этапы этого запуска' });
  await stages.locator('[id="run-stage-developer"]').uncheck();
  const group = modal.getByRole('region', { name: 'Группа задач', exact: true });
  const select = async (ids: string[]) => {
    await group.locator('p-multiselect').click();
    for (const id of ids) await page.getByRole('option', { name: new RegExp('^' + id + ' ·') }).click();
    await modal.getByRole('heading', { name: '6. Запуск задачи', exact: true }).click();
  };
  await select([a.id, b.id]);
  await group.getByText(/Выбрано задач: 2\./).waitFor();
  app.taskService.askQuestions({ id: b.id, questions: ['Clarify?'], actor: 'agent' });
  await group.getByText(/Есть открытые вопросы: 1\./).waitFor();
  assert.equal(await group.getByRole('button', { name: 'Поставить группу в очередь (2)', exact: true }).isDisabled(), true);
  await group.getByRole('button', { name: 'Убрать из группы ' + b.id, exact: true }).click();
  await select([c.id]);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'Batch fits narrow modal');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  mkdirSync('dist/acceptance', { recursive: true }); await page.screenshot({ path: 'dist/acceptance/batch-launch.png' });
  await page.route('**/api/automation/batch', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Fixture batch conflict' } }) }));
  await group.getByRole('button', { name: 'Поставить группу в очередь (2)', exact: true }).click();
  await modal.getByRole('alert').filter({ hasText: 'Fixture batch conflict' }).waitFor();
  assert.equal(app.automationService.list().length, 0);
  await page.unroute('**/api/automation/batch');
  await group.getByRole('button', { name: 'Поставить группу в очередь (2)', exact: true }).click();
  await page.getByRole('dialog', { name: 'Очередь агентов', exact: true }).waitFor();
  const runs = app.automationService.list(); assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(run => run.taskId).sort(), [a.id, c.id].sort());
  assert.ok(runs.every(run => run.settings.pipeline.join() === 'analyst' && run.settings.checks.length === 0));
  assert.deepEqual(app.automationService.settings(), settings);
  assert.equal(requests.length, 2); assert.equal(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(errors, []);
  console.log('PASS: batch entry/multiselect, analyst-only without checks, changing eligibility/removal, retry snapshot/key, atomic queue, unchanged defaults and mobile. No models or real task store.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true }); }
