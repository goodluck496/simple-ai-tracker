import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';

const appRoot = path.resolve(import.meta.dirname, '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'sat-item-links-'));
const screenshotsDir = path.resolve('.sat/screenshots');
mkdirSync(screenshotsDir, { recursive: true });

const app = createContainer({
  config: {
    appRoot: root,
    dbPath: path.join(root, 'data', 'tracker.db'),
    webDistDir: path.join(appRoot, 'dist', 'web', 'browser'),
  },
  logger: new SilentLogger(),
});
const server = createApiServer(app);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  // 1. Setup tasks in default workspace
  const defaultTask = app.taskService.createTask({ title: 'Default Workspace Task' });

  // 2. Setup workspace B with distinct tasks
  const wsB = 'ws-b';
  app.workspaceManager.create(wsB, 'Workspace B');
  let taskB1Id = '';
  let taskB2Id = '';

  app.workspaceManager.within(wsB, () => {
    const b1 = app.taskService.createTask({
      title: 'Task B1 with Questions and Plan',
      description: 'Description for Task B1',
    });
    taskB1Id = b1.id;
    app.taskService.attachPlan({
      id: b1.id,
      planContent: '# Plan for B1\n1. First step of plan.',
      summary: 'Attached initial plan',
    });
    app.taskService.askQuestions({
      id: b1.id,
      questions: ['Should this task be verified in E2E?'],
    });

    const b2 = app.taskService.createTask({
      title: 'Task B2 Simple',
      description: 'Description for Task B2',
    });
    taskB2Id = b2.id;
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.route('**/api/auth/status', (route) => route.fulfill({ json: { enabled: false } }));

  // Tab 1: open default workspace
  const tab1 = await context.newPage();
  tab1.setDefaultTimeout(15000);
  const tab1Errors: string[] = [];
  tab1.on('pageerror', (err) => tab1Errors.push(err.message));
  await tab1.goto(baseUrl);
  await tab1.getByText('Default Workspace Task').first().waitFor();
  assert.equal(await tab1.evaluate(() => sessionStorage.getItem('sat.workspace') ?? 'default'), 'default');

  // Tab 2: external tab directly opening /item/<ID>/overview?workspace=ws-b
  const tab2 = await context.newPage();
  tab2.setDefaultTimeout(15000);
  const tab2Errors: string[] = [];
  tab2.on('pageerror', (err) => tab2Errors.push(err.message));

  await tab2.goto(`${baseUrl}/item/${taskB1Id}/overview?workspace=${wsB}`);
  const dialog = tab2.getByRole('dialog', { name: 'Карточка задачи' });
  await dialog.waitFor();
  await dialog.getByText(taskB1Id, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('textbox', { name: 'Название задачи' }).inputValue(), 'Task B1 with Questions and Plan');
  assert.equal(await tab2.evaluate(() => sessionStorage.getItem('sat.workspace')), wsB);
  assert.ok(tab2.url().includes(`/item/${taskB1Id}/overview?workspace=${wsB}`));

  // Screenshot of opened card
  await tab2.screenshot({ path: path.join(screenshotsDir, 'item-links.png') });

  // Tab 2: Click through all 5 tabs and verify URL & active panel
  const tabsList: { tab: string; label: string; textInPanel: string }[] = [
    { tab: 'plan', label: 'План', textInPanel: 'First step of plan' },
    { tab: 'questions', label: 'Вопросы', textInPanel: 'Should this task be verified in E2E?' },
    { tab: 'discussion', label: 'Обсуждение', textInPanel: 'Обсуждение и история решений' },
    { tab: 'relations', label: 'Связи', textInPanel: 'Связи' },
    { tab: 'overview', label: 'Обзор', textInPanel: 'Описание и критерии приёмки' },
  ];

  for (const item of tabsList) {
    await dialog.locator('p-tab').filter({ hasText: item.label }).click();
    await tab2.waitForURL((url) => url.pathname.endsWith(`/${item.tab}`) && url.searchParams.get('workspace') === wsB);
    await dialog.getByText(item.textInPanel).first().waitFor();
  }

  // Close card in Tab 2 and verify back on board with ws-b
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await tab2.waitForURL((url) => !url.pathname.includes('/item/'));
  await tab2.getByText('Task B2 Simple').first().waitFor();

  // Tab 1: Normalization checks from external link when Tab 1 had 'default' workspace active
  // 1) Link without tab -> normalizes to questions because task B1 has open questions
  await tab1.goto(`${baseUrl}/item/${taskB1Id}?workspace=${wsB}`);
  await tab1.waitForURL((url) => url.pathname.endsWith('/questions') && url.searchParams.get('workspace') === wsB);
  const tab1Dialog = tab1.getByRole('dialog', { name: 'Карточка задачи' });
  await tab1Dialog.waitFor();
  await tab1Dialog.getByText('Should this task be verified in E2E?').first().waitFor();

  // 2) Link with unknown slug -> normalizes to questions
  await tab1.goto(`${baseUrl}/item/${taskB1Id}/unknown-slug?workspace=${wsB}`);
  await tab1.waitForURL((url) => url.pathname.endsWith('/questions') && url.searchParams.get('workspace') === wsB);
  await tab1Dialog.getByText('Should this task be verified in E2E?').first().waitFor();

  // 3) Explicit plan -> opens plan even if open questions exist
  await tab1.goto(`${baseUrl}/item/${taskB1Id}/plan?workspace=${wsB}`);
  await tab1.waitForURL((url) => url.pathname.endsWith('/plan') && url.searchParams.get('workspace') === wsB);
  await tab1Dialog.getByText('First step of plan').first().waitFor();

  // 4) Reload preserves workspace and tab
  await tab1.reload();
  await tab1.waitForURL((url) => url.pathname.endsWith('/plan') && url.searchParams.get('workspace') === wsB);
  await tab1Dialog.getByText('First step of plan').first().waitFor();

  // 5) Test item/create?workspace=ws-b
  await tab1.goto(`${baseUrl}/item/create?workspace=${wsB}`);
  const createDialog = tab1.getByRole('dialog', { name: 'Карточка задачи' });
  await createDialog.waitFor();
  assert.ok(tab1.url().includes(`/item/create?workspace=${wsB}`));

  // Fill and save
  await createDialog.getByRole('textbox', { name: 'Название задачи' }).fill('New E2E Created Task');
  await createDialog.getByRole('button', { name: 'Создать', exact: true }).click();

  // After creation, URL should navigate to /item/<new-id>/overview?workspace=ws-b
  await tab1.waitForURL((url) => url.pathname.includes('/item/') && !url.pathname.includes('/create') && url.searchParams.get('workspace') === wsB);
  await tab1Dialog.waitFor();
  assert.equal(await tab1Dialog.getByRole('textbox', { name: 'Название задачи' }).inputValue(), 'New E2E Created Task');

  // Test cancel creation
  await tab1.goto(`${baseUrl}/item/create?workspace=${wsB}`);
  await createDialog.waitFor();
  await createDialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await createDialog.waitFor({ state: 'hidden' });
  await tab1.waitForURL((url) => !url.pathname.includes('/item/'));

  // 6) Error handling on non-existent workspace
  let taskRequestedForCurrentWs = false;
  tab2.on('request', (req) => {
    if (req.url().includes(`/api/tasks/${taskB1Id}`) && req.headers()['x-tracker-workspace'] !== wsB) {
      taskRequestedForCurrentWs = true;
    }
  });

  await tab2.goto(`${baseUrl}/item/${taskB1Id}/overview?workspace=non-existent-workspace`);
  const errorAlert = tab2.getByRole('alert');
  await errorAlert.waitFor();
  await errorAlert.getByText(/Пространство «non-existent-workspace» не найдено/).waitFor();
  assert.equal(taskRequestedForCurrentWs, false, 'Must not request task from active workspace when target is unknown');
  assert.equal(await dialog.count(), 0, 'Card must not open on unknown workspace');

  // Click return to board
  await errorAlert.getByRole('button', { name: 'Вернуться на доску', exact: true }).click();
  await errorAlert.waitFor({ state: 'hidden' });
  await tab2.getByText('Task B2 Simple').first().waitFor();

  // 7) Browser History Back / Forward navigation
  // Click B-2 card
  await tab2.getByText('Task B2 Simple').first().click();
  await dialog.waitFor();
  await dialog.getByText(taskB2Id, { exact: true }).waitFor();
  assert.ok(tab2.url().includes(`/item/${taskB2Id}/`));

  // Switch to B-1 via navigation
  await tab2.goto(`${baseUrl}/item/${taskB1Id}/overview?workspace=${wsB}`);
  await dialog.getByText(taskB1Id, { exact: true }).waitFor();

  // Go back -> B-2 is open
  await tab2.goBack();
  await dialog.getByText(taskB2Id, { exact: true }).waitFor();
  assert.ok(tab2.url().includes(`/item/${taskB2Id}/`));

  // Go forward -> B-1 is open
  await tab2.goForward();
  await dialog.getByText(taskB1Id, { exact: true }).waitFor();
  assert.ok(tab2.url().includes(`/item/${taskB1Id}/`));

  // Go back to board
  await tab2.goBack();
  await dialog.getByText(taskB2Id, { exact: true }).waitFor();
  await tab2.goBack();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(tab2.url().includes('/item/'), false);

  assert.deepEqual(tab1Errors, []);
  assert.deepEqual(tab2Errors, []);
  console.log('PASS: item links, tab normalization, creation form, error handling, history navigation. No models used.');
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close();
  rmSync(root, { recursive: true, force: true });
}
