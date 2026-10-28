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

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-task-teams-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'), webDistDir: path.resolve('dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app); const browser = await chromium.launch({ headless: true });
try {
  const service = app.automationService;
  service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })), pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] });
  const task = app.taskService.createTask({ title: 'Single developer fixture' });
  app.taskService.attachPlan({ id: task.id, planContent: '# Approved fixture plan', actor: 'agent' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(18000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.getByRole('button', { name: 'Команда агентов', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Команда агентов' }); await dialog.waitFor();
  await page.waitForTimeout(250);
  const original = (await dialog.boundingBox())!;
  for (const tab of ['Модели', 'Команда и этапы', 'Запуск', 'Компьютер и проект']) {
    await dialog.getByRole('tab', { name: tab, exact: true }).click();
    const current = (await dialog.boundingBox())!;
    assert.ok(Math.abs(current.height - original.height) < 2 && Math.abs(current.width - original.width) < 2, `Modal changed geometry on ${tab}`);
    assert.ok(await dialog.locator('.settings-footer').evaluate(element => {
      const color = getComputedStyle(element).backgroundColor; return color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color);
    }), 'Footer must be opaque');
  }
  await dialog.getByRole('combobox', { name: 'Область настроек', exact: true }).click();
  await page.getByRole('option', { name: 'Команда выбранной задачи', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Задача для настройки команды', exact: true }).click();
  await page.getByRole('option', { name: `${task.id} · Single developer fixture`, exact: true }).click();
  await dialog.getByText('Наследует команду проекта', { exact: true }).waitFor();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Сохранить команду задачи' && !button.disabled));
  assert.equal(await dialog.getByRole('combobox', { name: 'Режим выполнения', exact: true }).count(), 0);
  await dialog.getByRole('tab', { name: 'Запуск', exact: true }).click();
  const selectedStages = dialog.getByRole('region', { name: 'Этапы этого запуска' });
  for (const role of ['analyst', 'tester', 'reviewer']) await selectedStages.locator(`[id="run-stage-${role}"]`).uncheck();
  await selectedStages.getByText(/Выбрано этапов: 1\./).waitFor();
  assert.equal(await selectedStages.locator('ol li').count(), 1);
  await selectedStages.locator('[id="run-stage-reviewer"]').check();
  await selectedStages.getByText(/Выбрано этапов: 2\./).waitFor();
  assert.equal(await selectedStages.locator('ol li').count(), 2, 'Developer + reviewer needs no fixed team mode');
  await selectedStages.locator('[id="run-stage-reviewer"]').uncheck();
  await selectedStages.getByText(/Выбрано этапов: 1\./).waitFor();
  await dialog.getByRole('button', { name: 'Сохранить команду задачи', exact: true }).click();
  await dialog.getByText(`Команда задачи ${task.id} сохранена. Настройки проекта не изменены.`, { exact: true }).waitFor();
  assert.deepEqual(service.taskTeam(task.id).settings.pipeline, ['developer']); assert.equal(service.settings().pipeline.length, 4);
  await dialog.getByRole('button', { name: 'Наследовать команду проекта', exact: true }).click();
  await dialog.getByText('Задача наследует команду проекта.', { exact: true }).waitFor();
  assert.equal(service.taskTeam(task.id).overridden, false); assert.equal(await selectedStages.locator('ol li').count(), 4);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
    const footer = (await dialog.locator('.settings-footer').boundingBox())!; const bounds = (await dialog.boundingBox())!;
    assert.ok(footer.y + footer.height <= bounds.y + bounds.height + 2, 'Footer must remain inside modal');
  }
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const role of ['developer', 'tester', 'reviewer']) await selectedStages.locator(`[id="run-stage-${role}"]`).uncheck();
  await selectedStages.getByText(/Выбрано этапов: 1\./).waitFor();
  assert.equal(await selectedStages.locator('ol li').count(), 1, 'Analyst-only is selectable');
  mkdirSync('dist/acceptance', { recursive: true }); await page.screenshot({ path: 'dist/acceptance/task-team-settings.png' });
  await dialog.getByRole('button', { name: 'Поставить в очередь', exact: true }).click();
  await page.getByRole('dialog', { name: 'Очередь агентов', exact: true }).waitFor();
  assert.deepEqual(service.list(task.id)[0].settings.pipeline, ['analyst']);
  assert.equal(service.settings().pipeline.length, 4); assert.equal(service.taskTeam(task.id).overridden, false, 'Per-run selection must not persist');
  console.log('PASS: fixed geometry/footer, arbitrary launch roles, developer/reviewer/analyst selection, exact immutable queue snapshot, project/task isolation/reset, responsive. No models or real task store.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true }); }
