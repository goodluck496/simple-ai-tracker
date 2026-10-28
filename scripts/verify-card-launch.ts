import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../shared/automation/presets.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-card-launch-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'), webDistDir: path.resolve(import.meta.dirname, '../dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const settings: AutomationSettings = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'native', label: 'Codex', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map((role) => ({ id: role, role, runner: 'codex', model: 'fixture-model', connectionId: 'native', instructions: '' })),
    pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] };
  app.automationService.configure(settings);
  const ready = app.taskService.createTask({ title: 'Ready card launch' });
  app.taskService.attachPlan({ id: ready.id, planContent: '# Plan\nImplement.', actor: 'agent' });
  const backlog = app.taskService.createTask({ title: 'Backlog card launch' });
  const blocked = app.taskService.createTask({ title: 'Blocked card launch' });
  app.taskService.askQuestions({ id: blocked.id, questions: ['Clarify?'], actor: 'agent' });
  const done = app.taskService.createTask({ title: 'Done card launch' });
  app.taskService.setStatus({ id: done.id, status: 'done', actor: 'user' });
  const feature = app.taskService.createTask({ title: 'Feature card launch', type: 'feature' });
  const child = app.taskService.createTask({ title: 'Child card launch', parentId: feature.id });
  const unconfigured = app.taskService.createTask({ title: 'Needs configuration' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  let enqueues = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/automation/runs')) enqueues++; });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const start = (id: string) => page.getByRole('button', { name: `Запустить в разработку ${id}`, exact: true }).first();
  await start(ready.id).waitFor();
  for (const id of [ready.id, child.id, feature.id]) {
    for (const button of await page.getByRole('button', { name: `Запустить в разработку ${id}`, exact: true }).all()) {
      assert.ok(await button.evaluate((element) => {
        const actions = element.closest('.sat-card__actions, .sat-feature__right');
        return !!actions?.querySelector('.pi-pencil') && element.textContent?.trim() === '';
      }), 'Launch must be an icon in the existing edit/action row');
    }
  }
  assert.equal(await start(blocked.id).isDisabled(), true); assert.equal(await start(done.id).isDisabled(), true);
  assert.equal(await start(feature.id).isEnabled(), true); assert.equal(await start(child.id).isEnabled(), true);
  await start(ready.id).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  const queue = page.getByRole('dialog', { name: 'Очередь агентов', exact: true });
  const modal = page.getByRole('dialog', { name: 'Команда агентов', exact: true });
  await modal.getByRole('region', { name: 'Этапы этого запуска' }).waitFor();
  assert.equal(enqueues, 0, 'A card opens preview without creating any run');
  await modal.getByRole('button', { name: 'Поставить в очередь', exact: true }).click();
  await queue.getByRole('article', { name: 'Детали запуска' }).waitFor();
  assert.equal(app.automationService.list(ready.id).length, 1); assert.equal(enqueues, 1);
  assert.equal(await page.getByRole('dialog', { name: 'Карточка задачи', exact: true }).count(), 0);
  assert.equal(await page.locator('.sat-board--dragging').count(), 0);
  const closeQueue = async () => { await queue.locator('.p-dialog-close-button').click(); await queue.waitFor({ state: 'hidden' }); };
  await closeQueue(); await start(ready.id).click(); await queue.getByRole('article', { name: 'Детали запуска' }).waitFor();
  assert.equal(enqueues, 1, 'An active run must be opened without another enqueue'); await closeQueue();
  await start(backlog.id).click(); await modal.getByRole('region', { name: 'Этапы этого запуска' }).waitFor();
  await modal.getByRole('button', { name: 'Поставить в очередь', exact: true }).click(); await queue.getByRole('article', { name: 'Детали запуска' }).waitFor();
  assert.equal(app.automationService.list(backlog.id).length, 1); await closeQueue();
  app.automationService.configure({ ...settings, checks: [] });
  await start(unconfigured.id).click();
  await modal.getByRole('region', { name: 'Этапы этого запуска' }).waitFor();
  await modal.getByRole('button', { name: 'Поставить в очередь', exact: true }).click();
  await modal.getByRole('alert').filter({ hasText: 'Ошибка запуска:' }).waitFor();
  assert.equal(await modal.getByRole('tab', { name: 'Запуск', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok((await modal.getByRole('combobox', { name: 'Задача для запуска', exact: true }).innerText()).includes(unconfigured.id));
  assert.equal(app.automationService.list(unconfigured.id).length, 0);
  await modal.locator('.p-dialog-close-button').click(); await modal.waitFor({ state: 'hidden' });
  app.automationService.configure(settings);
  await start(feature.id).click(); await modal.getByRole('region', { name: 'Этапы этого запуска' }).waitFor();
  await modal.getByRole('button', { name: 'Поставить в очередь', exact: true }).click(); await queue.getByRole('article', { name: 'Детали запуска' }).waitFor();
  assert.equal(app.automationService.list(feature.id).length, 1); await closeQueue();
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await start(child.id).evaluate((element) => { const card = element.closest('.sat-card')!; return card.scrollWidth <= card.clientWidth + 2; }));
  }
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'dist/acceptance/card-launch-actions.png', fullPage: true });
  console.log('PASS: ready/backlog/feature/subtask card actions, blocked/done, duplicate clicks, active run reuse, configuration fallback and preselection, no card opening/drag or responsive overflow.');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
