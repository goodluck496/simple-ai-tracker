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
  const first = await context.newPage();
  const errors: string[] = [];
  first.on('pageerror', (error) => errors.push(error.message));
  first.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
  await first.goto(base);
  await first.getByText('Default project acceptance', { exact: true }).first().waitFor().catch(async (error) => {
    console.error(JSON.stringify({ errors, body: (await first.locator('body').innerText()).slice(0, 1000) }));
    throw error;
  });
  await first.locator('sat-workspace-selector p-select').click();
  await first.getByRole('option', { name: 'Second project' }).click();
  await first.getByText('Second project acceptance', { exact: true }).first().waitFor();
  assert.equal(await first.getByText('Default project acceptance', { exact: true }).count(), 0);
  const second = await context.newPage();
  await second.goto(base);
  await second.getByText('Default project acceptance', { exact: true }).first().waitFor();
  await first.reload();
  await first.getByText('Second project acceptance', { exact: true }).first().waitFor();
  await first.locator('sat-workspace-selector p-select').click();
  await first.getByRole('option', { name: 'Default', exact: true }).click();
  await first.getByText('Default project acceptance', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  const artifacts = path.join(appRoot, 'dist', 'acceptance');
  mkdirSync(artifacts, { recursive: true });
  await first.getByRole('button', { name: 'Новое пространство', exact: true }).click();
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
  await first.locator('sat-workspace-selector p-select').click();
  await first.getByRole('option', { name: 'Created project', exact: true }).click();
  await first.waitForFunction(() => sessionStorage.getItem('sat.workspace') === 'created-project');
  assert.deepEqual(errors, []);
  await first.screenshot({ path: path.join(artifacts, 'workspaces.png'), fullPage: true });
  console.log('PASS: selector A/B/A, isolated tabs, reload persistence, no page errors.');
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close();
  rmSync(root, { recursive: true, force: true });
}
