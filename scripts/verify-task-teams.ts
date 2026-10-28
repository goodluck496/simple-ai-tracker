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
import { TrackerToolRegistry } from '../server/src/mcp/tools.js';
import { ProjectWorker } from '../server/src/automation/worker/project-worker.js';
import type { ExecutionStatus } from '../shared/automation/project.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-task-teams-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'), webDistDir: path.resolve('dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app); const browser = await chromium.launch({ headless: true });
let projectTimer: ReturnType<typeof setInterval> | undefined; let projectTick: Promise<void> | undefined;
try {
  const service = app.automationService;
  const registry = new TrackerToolRegistry(app); let execution: ExecutionStatus = { state: 'stopped', hostName: 'fixture-host' };
  const control = { status: () => execution, async start() { execution = { state: 'running', hostName: 'fixture-host', pid: 123 }; return execution; }, async stop() { execution = { state: 'stopped', hostName: 'fixture-host' }; return execution; } };
  const projectWorker = new ProjectWorker({ async call<T>(name: string, args = {}): Promise<T> {
    const result = await registry.call(name, args); const text = result.content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join(''); if (result.isError) throw new Error(text); return JSON.parse(text) as T;
  } }, 'fixture-host', undefined, { async list() { return []; } }, control);
  await projectWorker.tick(); projectTimer = setInterval(() => { if (!projectTick) projectTick = projectWorker.tick().finally(() => { projectTick = undefined; }); }, 50);
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
  await dialog.getByRole('button', { name: 'Запустить worker', exact: true }).click();
  await dialog.getByText('Worker запущен на подключённом компьютере.', { exact: true }).waitFor();
  assert.equal(execution.state, 'running');
  await dialog.getByRole('button', { name: 'Остановить worker', exact: true }).click();
  await dialog.getByText('Worker остановлен. Локальный хост остаётся доступен.', { exact: true }).waitFor();
  assert.equal(execution.state, 'stopped'); assert.equal(service.projects.status().online, true);
  for (const tab of ['Модели', 'Команда и этапы', 'Запуск', 'Компьютер и проект']) {
    await dialog.getByRole('tab', { name: tab, exact: true }).click();
    const current = (await dialog.boundingBox())!;
    assert.ok(Math.abs(current.height - original.height) < 2 && Math.abs(current.width - original.width) < 2, `Modal changed geometry on ${tab}`);
    assert.ok(await dialog.locator('.settings-footer').evaluate(element => {
      const color = getComputedStyle(element).backgroundColor; return color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color);
    }), 'Footer must be opaque');
  }
  await dialog.getByRole('tab', { name: 'Команда и этапы', exact: true }).click();
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const picker = dialog.getByRole('combobox', { name: 'Добавить роль', exact: true });
    await picker.scrollIntoViewIfNeeded();
    await picker.evaluate(element => {
      const panel = element.closest('.p-tabpanels')!;
      panel.scrollTop += element.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom + 8;
    });
    const scrollBefore = await dialog.locator('.p-tabpanels').evaluate(element => element.scrollTop);
    await picker.click();
    const popup = page.getByRole('listbox'); await popup.waitFor();
    assert.equal(await popup.evaluate(element => element.closest('.p-tabpanels') === null), true, 'Role popup must escape the scroll/clipping container');
    assert.ok(Math.abs(await dialog.locator('.p-tabpanels').evaluate(element => element.scrollTop) - scrollBefore) <= 2, 'Opening roles must not move modal content');
    const bounds = (await popup.boundingBox())!;
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 2, 'Role choices must remain in viewport');
    await popup.hover(); await page.mouse.wheel(0, 180);
    await page.waitForFunction((list: HTMLElement) => list.isConnected && (list.parentElement?.scrollTop ?? 0) > 0, await popup.elementHandle());
    await popup.waitFor({ state: 'visible' });
    if (viewport.width === 1440) { mkdirSync('dist/acceptance', { recursive: true }); await page.screenshot({ path: 'dist/acceptance/role-picker.png' }); }
    await page.getByRole('option', { name: 'Тестировщик — проверки', exact: true }).click();
    await popup.waitFor({ state: 'hidden' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('combobox', { name: 'Область настроек', exact: true }).click();
  await page.getByRole('option', { name: 'Команда выбранной задачи', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Задача для настройки команды', exact: true }).click();
  await page.getByRole('option', { name: `${task.id} · Single developer fixture`, exact: true }).click();
  await dialog.getByText('Наследует команду проекта', { exact: true }).waitFor();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Сохранить команду задачи' && !button.disabled));
  assert.equal(await dialog.getByRole('combobox', { name: 'Режим выполнения', exact: true }).count(), 0);
  await dialog.getByRole('tab', { name: 'Запуск', exact: true }).click();
  assert.equal(await dialog.getByRole('combobox', { name: 'Задача для запуска', exact: true }).count(), 0, 'Task scope uses one task selector');
  await dialog.getByText(`Задача для запуска: ${task.id}`, { exact: true }).waitFor();
  const selectedStages = dialog.getByRole('region', { name: 'Этапы этого запуска' });
  for (const role of ['analyst', 'tester', 'reviewer']) await selectedStages.locator(`[id="run-stage-${role}"]`).uncheck();
  await selectedStages.getByText(/Выбрано этапов: 1\./).waitFor();
  assert.equal(await selectedStages.locator('.launch-agent-row.stage-enabled').count(), 1);
  assert.equal(await selectedStages.locator('.launch-agent-row').count(), 4, 'Each agent has one row including disabled agents');
  assert.equal(await selectedStages.locator('ol').count(), 0, 'No duplicate pipeline list');
  await selectedStages.locator('[id="run-stage-reviewer"]').check();
  await selectedStages.getByText(/Выбрано этапов: 2\./).waitFor();
  assert.equal(await selectedStages.locator('.launch-agent-row.stage-enabled').count(), 2, 'Developer + reviewer needs no fixed team mode');
  const reviewerRow = selectedStages.locator('[data-agent-id="reviewer"]');
  assert.equal(await reviewerRow.locator('p-checkbox').count(), 1, 'Toggle belongs to the agent row');
  await reviewerRow.getByRole('button', { name: 'Этап запуска выше:', exact: false }).click();
  assert.equal(await selectedStages.locator('.launch-agent-row').first().getAttribute('data-agent-id'), 'reviewer');
  assert.equal(await reviewerRow.locator('.stage-number').innerText(), '1');
  await reviewerRow.getByRole('button', { name: 'Этап запуска ниже:', exact: false }).click();
  await selectedStages.locator('[id="run-stage-reviewer"]').uncheck();
  await selectedStages.getByText(/Выбрано этапов: 1\./).waitFor();
  await dialog.getByRole('button', { name: 'Сохранить команду задачи', exact: true }).click();
  await dialog.getByText(`Команда задачи ${task.id} сохранена. Настройки проекта не изменены.`, { exact: true }).waitFor();
  assert.deepEqual(service.taskTeam(task.id).settings.pipeline, ['developer']); assert.equal(service.settings().pipeline.length, 4);
  await dialog.getByRole('button', { name: 'Наследовать команду проекта', exact: true }).click();
  await dialog.getByText('Задача наследует команду проекта.', { exact: true }).waitFor();
  assert.equal(service.taskTeam(task.id).overridden, false); assert.equal(await selectedStages.locator('.launch-agent-row.stage-enabled').count(), 4);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
    assert.ok(await selectedStages.locator('.launch-agent-row').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth + 2)), 'Agent rows fit mobile viewport');
    const footer = (await dialog.locator('.settings-footer').boundingBox())!; const bounds = (await dialog.boundingBox())!;
    assert.ok(footer.y + footer.height <= bounds.y + bounds.height + 2, 'Footer must remain inside modal');
  }
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const role of ['developer', 'tester', 'reviewer']) await selectedStages.locator(`[id="run-stage-${role}"]`).uncheck();
  await selectedStages.getByText(/Выбрано этапов: 1\./).waitFor();
  assert.equal(await selectedStages.locator('.launch-agent-row.stage-enabled').count(), 1, 'Analyst-only is selectable');
  mkdirSync('dist/acceptance', { recursive: true }); await page.screenshot({ path: 'dist/acceptance/task-team-settings.png' });
  await dialog.getByRole('button', { name: 'Поставить в очередь', exact: true }).click();
  await page.getByRole('dialog', { name: 'Очередь агентов', exact: true }).waitFor();
  assert.deepEqual(service.list(task.id)[0].settings.pipeline, ['analyst']);
  assert.equal(service.settings().pipeline.length, 4); assert.equal(service.taskTeam(task.id).overridden, false, 'Per-run selection must not persist');
  console.log('PASS: fixed geometry/footer, arbitrary launch roles, developer/reviewer/analyst selection, exact immutable queue snapshot, project/task isolation/reset, responsive. No models or real task store.');
} finally { if (projectTimer) clearInterval(projectTimer); await projectTick; await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true }); }
