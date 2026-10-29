import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-create-type-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'fixture.db'), webDistDir: path.resolve(process.env.SAT_WEB_DIST ?? 'dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app), browser = await chromium.launch({ headless: true });
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  for (const [label, type] of [['Баг', 'bug'], ['Фича', 'feature'], ['Задача', 'task']] as const) {
    await page.locator('.create-combobutton').click();
    await page.locator('.create-menu p-button').filter({ hasText: label }).locator('button').click();
    const card = page.getByRole('dialog', { name: 'Карточка задачи', exact: true });
    await card.locator('#sat-title').fill(`Fixture ${type}`);
    await card.locator('.head-type-select').getByRole('combobox').filter({ hasText: label }).waitFor();
    await card.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('.header-id-badge'));
    assert.equal(app.taskService.listTasks({}).find(task => task.title === `Fixture ${type}`)?.type, type);
    await card.locator('.sidebar-header-right p-button').last().locator('button').click();
  }
  await page.locator('.create-combobutton').click();
  await page.locator('.create-menu p-button').filter({ hasText: 'Баг' }).locator('button').click();
  const card = page.getByRole('dialog', { name: 'Карточка задачи', exact: true });
  await card.locator('.head-type-select').click();
  await page.getByRole('option', { name: 'Задача', exact: true }).click();
  await card.locator('#sat-title').fill('Manual override');
  await card.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.header-id-badge'));
  assert.equal(app.taskService.listTasks({}).find(task => task.title === 'Manual override')?.type, 'task');
  assert.deepEqual(errors, []);
  console.log('PASS: menu creates bug, feature and task with their selected types; no browser errors. Synthetic data only.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
