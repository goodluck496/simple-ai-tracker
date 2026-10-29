import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../shared/automation/presets.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-integrated-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data/tracker.db'), webDistDir: path.resolve(process.env.SAT_WEB_DIST ?? 'dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app), browser = await chromium.launch({ headless: true });
try {
  app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'n', label: 'Configured model', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map(role => ({ id: role, role, runner: 'codex', model: 'fixture', connectionId: 'n', instructions: '' })),
    pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'node', args: ['--version'] }] });
  const task = app.taskService.createTask({ title: 'Planless task and trusted execution fixture' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); console.log('pageerror: ' + error.message); });
  page.on('console', message => { if (message.type() === 'error') console.log('console error: ' + message.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const openCard = async () => { await page.locator(`article[data-task-id="${task.id}"]`).first().click(); };
  await openCard();
  const card = page.getByRole('dialog', { name: 'Карточка задачи', exact: true });
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#sat-title')?.value === 'Planless task and trusted execution fixture');
  const trust = card.getByRole('checkbox', { name: 'Доверенный запуск — без лимитов', exact: true });
  assert.equal(await trust.isChecked(), false);
  await trust.check(); await card.getByText(/Денежного потолка нет/).waitFor();
  await card.locator('.sidebar-footer p-button').filter({ hasText: 'Сохранить' }).locator('button').click({ timeout: 5000 });
  for (let attempt = 0; attempt < 40 && !app.taskService.getTaskCard(task.id).trustedExecution; attempt++) await page.waitForTimeout(50);
  assert.equal(app.taskService.getTaskCard(task.id).trustedExecution, true);
  for (const width of [390, 844]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'Task trust controls fit narrow screens');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Запустить в разработку ' + task.id, exact: true }).first().click();
  const launch = page.getByRole('dialog', { name: 'Команда агентов', exact: true });
  const enqueue = launch.locator('p-button').filter({ hasText: 'Поставить в очередь' }).locator('button').first();
  await enqueue.waitFor();
  await enqueue.click(); // Actionability waits for the asynchronous task-team preview.
  const queue = page.getByRole('dialog', { name: 'Очередь агентов', exact: true });
  await queue.locator('.queue-main .badge-limits').getByText('Без лимитов', { exact: true }).waitFor();
  const run = app.automationService.list(task.id)[0];
  assert.equal(run.trustedExecution, true);
  assert.deepEqual(run.settings.pipeline, ['developer', 'tester']);
  await queue.locator('.p-dialog-close-button').click();
  await openCard(); await trust.uncheck();
  await Promise.all([page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/api/tasks/' + task.id)), card.locator('.sidebar-footer p-button').filter({ hasText: 'Сохранить' }).locator('button').click()]);
  assert.equal(app.taskService.getTaskCard(task.id).trustedExecution, false);
  assert.equal(app.automationService.detail(run.id).run.trustedExecution, true, 'Existing run retains its immutable trust decision');
  await card.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.locator('.sat-col__foot p-button').filter({ hasText: 'задача' }).locator('button').first().click();
  assert.equal(await trust.isChecked(), false, 'New task defaults to bounded execution');
  await card.locator('#sat-title').fill('New bounded fixture');
  await Promise.all([page.waitForResponse(response => response.url().includes('/api/tasks/') && response.request().method() === 'GET'), card.getByRole('button', { name: 'Создать', exact: true }).click()]);
  assert.ok(app.taskService.listTasks({}).some(item => item.title === 'New bounded fixture' && item.trustedExecution === false));
  mkdirSync('dist/acceptance', { recursive: true }); await page.screenshot({ path: 'dist/acceptance/integrated-workflow.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: trusted checkbox defaults/persistence, planless developer+tester launch, queue indication, immutable snapshots, create/edit, narrow layout, no browser errors. No paid models or real task data.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
