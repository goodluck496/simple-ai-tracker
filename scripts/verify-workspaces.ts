import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';

const appRoot = path.resolve(import.meta.dirname, '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'sat-browser-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'),
  webDistDir: path.join(appRoot, 'dist', 'web', 'browser') }, logger: new SilentLogger() });
const server = createApiServer(app);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  app.taskService.createTask({ title: 'Default project acceptance' });
  app.workspaceManager.create('second', 'Second project');
  app.workspaceManager.within('second', () => app.taskService.createTask({ title: 'Second project acceptance' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await context.route('**/api/auth/status', route => route.fulfill({ json: { enabled: false } }));
  const first = await context.newPage();
  first.setDefaultTimeout(15000);
  const errors: string[] = [];
  first.on('pageerror', (error) => errors.push(error.message));
  first.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
  await first.goto(base);
  await first.getByText('Default project acceptance', { exact: true }).first().waitFor().catch(async (error) => {
    console.error(JSON.stringify({ errors, body: (await first.locator('body').innerText()).slice(0, 1000) }));
    throw error;
  });
  const picker = first.getByRole('dialog', { name: 'Рабочие пространства' });
  const openPicker = () => first.getByRole('button', { name: 'Выбрать рабочее пространство' }).click();
  const tile = (name: string) => picker.locator('.workspace-card').filter({ has: first.getByRole('button', { name: 'Открыть пространство ' + name, exact: true }) });
  const search = first.getByRole('textbox', { name: 'Поиск по задачам' });
  assert.ok((await search.boundingBox())!.width > 250, 'The search input has room on desktop');
  await openPicker();
  await tile('Second project').getByRole('button', { name: 'Переименовать пространство' }).click();
  const edit = first.getByRole('dialog', { name: 'Переименовать пространство' });
  await edit.getByRole('button', { name: 'Слива', exact: true }).click();
  await edit.getByRole('button', { name: 'Сохранить название' }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.equal(await tile('Second project').getAttribute('data-background'), 'plum');
  await picker.getByRole('button', { name: 'Открыть пространство Second project' }).click();
  await first.getByText('Second project acceptance', { exact: true }).first().waitFor();
  assert.equal(await first.getByText('Default project acceptance', { exact: true }).count(), 0);
  const second = await context.newPage();
  await second.goto(base);
  await second.getByText('Default project acceptance', { exact: true }).first().waitFor();
  await first.reload();
  await first.getByText('Second project acceptance', { exact: true }).first().waitFor();
  await openPicker();
  assert.equal(await tile('Second project').getAttribute('data-background'), 'plum');
  assert.equal(await picker.getByRole('button', { name: 'Открыть пространство Second project' }).getAttribute('aria-current'), 'true');
  await picker.getByRole('button', { name: 'Открыть пространство Default', exact: true }).click();
  await first.getByText('Default project acceptance', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  const artifacts = path.join(appRoot, 'dist', 'acceptance');
  mkdirSync(artifacts, { recursive: true });
  await openPicker();
  for (const viewport of [{ width: 1440, height: 950 }, { width: 1120, height: 900 }, { width: 844, height: 580 }, { width: 390, height: 844 }]) {
    await first.setViewportSize(viewport);
    assert.ok(await picker.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
    const field = (await search.boundingBox())!;
    assert.ok(field.width > 200 && field.x + field.width <= viewport.width + 1, JSON.stringify({ viewport, field }));
  }
  await first.setViewportSize({ width: 1440, height: 950 });
  await first.screenshot({ path: path.join(artifacts, 'workspace-tiles.png'), fullPage: true });
  await picker.getByRole('button', { name: 'Новое пространство', exact: true }).click();
  const dialog = first.getByRole('dialog', { name: 'Новое пространство' });
  for (const viewport of [{ width: 1440, height: 950 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await first.setViewportSize(viewport);
    const appearance = await dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return { background: style.backgroundColor, expected: style.getPropertyValue('--p-dialog-background').trim(),
        color: style.color, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    });
    assert.ok(appearance.expected, 'Dialog theme token must exist');
    const themedBackground = await dialog.evaluate((element) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--p-dialog-background)';
      element.append(probe);
      const result = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return result;
    });
    assert.equal(appearance.background, themedBackground, 'Workspace dialog follows the application dialog theme');
    assert.notEqual(appearance.background, appearance.color);
    assert.ok(appearance.left >= 0 && appearance.right <= viewport.width && appearance.top >= 0 && appearance.bottom <= viewport.height);
  }
  await first.screenshot({ path: path.join(artifacts, 'workspace-dialog.png'), fullPage: true });
  await dialog.getByRole('textbox').nth(0).fill('created-project');
  await dialog.getByRole('textbox').nth(1).fill('Created project');
  await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await picker.getByRole('button', { name: 'Открыть пространство Created project', exact: true }).click();
  await first.waitForFunction(() => sessionStorage.getItem('sat.workspace') === 'created-project');
  assert.deepEqual(errors, []);
  await first.screenshot({ path: path.join(artifacts, 'workspaces.png'), fullPage: true });
  console.log('PASS: workspace cards, background persistence, responsive search and dialogs, isolated tabs and reload.');
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close();
  rmSync(root, { recursive: true, force: true });
}
