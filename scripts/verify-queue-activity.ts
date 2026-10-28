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

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-activity-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data/tracker.db'), webDistDir: path.resolve('dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app); const browser = await chromium.launch({ headless: true });
try {
  const service = app.automationService;
  service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
    agents: [{ id: 'analyst', role: 'analyst', runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' }], pipeline: ['analyst'] });
  const task = app.taskService.createTask({ title: 'Long dependency preparation' }); service.enqueue(task.id);
  const run = service.claim('fixture')!;
  service.progress(run.id, run.leaseToken!, 'Проверка и подготовка зависимостей worktree до запуска агента.', 'setup');
  const snapshot = service.queue(false);
  let mode: 'active' | 'quiet' | 'stale' | 'failure' | 'hang' | 'finished' = 'active';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000);
  await page.clock.install();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/automation/queue', async route => {
    if (mode === 'hang') return;
    if (mode === 'failure') { await route.abort(); return; }
    const copy = structuredClone(snapshot); const item = copy.items[0]; const now = Date.parse(copy.serverTime);
    item.heartbeatAt = new Date(now - (mode === 'stale' ? 100000 : 1000)).toISOString();
    item.progressAt = item.phaseStartedAt = new Date(now - (mode === 'quiet' ? 180000 : 3000)).toISOString();
    if (mode === 'finished') { item.status = 'review'; item.stage = 1; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(copy) });
  });
  await page.goto('http://127.0.0.1:' + (server.address() as AddressInfo).port);
  await page.getByRole('button', { name: 'Очередь', exact: true }).click();
  const queue = page.getByRole('dialog', { name: 'Очередь агентов' });
  const card = queue.getByRole('button', { name: 'Запуск ' + task.id + ' ' + run.id, exact: true });
  await card.click();
  const indicator = queue.locator('.selected-activity .run-activity');
  await indicator.locator('.live').waitFor();
  assert.equal(await indicator.locator('p-progressbar').getAttribute('mode'), 'indeterminate');
  const previous = await indicator.innerText();
  await page.clock.fastForward(2000);
  assert.notEqual(await indicator.innerText(), previous, 'Timer changes while command emits no new events');
  await queue.getByRole('button', { name: 'Подробности запуска', exact: true }).click();
  const extra = queue.getByRole('complementary', { name: 'Подробности запуска' });
  await extra.getByText('Завершено этапов агентов: 0 / 1 (0%)', { exact: true }).waitFor();
  await extra.getByText(/Точный процент этой операции неизвестен/).waitFor();
  await extra.getByRole('button', { name: 'Закрыть подробности', exact: true }).click();
  mode = 'quiet'; await page.clock.fastForward(5000);
  await indicator.getByText('Worker отвечает, новых событий от операции давно нет', { exact: true }).waitFor();
  assert.equal(await indicator.locator('.live').count(), 1);
  mode = 'stale'; await page.clock.fastForward(5000);
  await indicator.getByText('Давно нет ответа worker — проверяется связь', { exact: true }).waitFor();
  assert.equal(await indicator.locator('p-progressbar').count(), 0);
  mode = 'failure'; await page.clock.fastForward(5000);
  await indicator.getByText('Нет связи с сервером — состояние не подтверждено', { exact: true }).waitFor();
  assert.equal(await indicator.locator('.live').count(), 0);
  mode = 'active'; await page.clock.fastForward(5000); await indicator.locator('.live').waitFor();
  mode = 'hang'; await page.clock.fastForward(20000);
  await indicator.getByText('Нет связи с сервером — состояние не подтверждено', { exact: true }).waitFor();
  mode = 'active'; await page.clock.fastForward(5000); await indicator.locator('.live').waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await indicator.locator('.live').evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.equal(await indicator.locator('.p-progressbar-value').evaluate(element => getComputedStyle(element, '::before').animationName), 'none');
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await queue.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  mkdirSync('dist/acceptance', { recursive: true }); await page.screenshot({ path: 'dist/acceptance/queue-activity.png' });
  mode = 'finished'; await page.clock.fastForward(5000);
  await indicator.waitFor({ state: 'hidden' });
  assert.equal(await queue.locator('.p-progressbar-indeterminate').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: active setup animation/timer, measured stage count, quiet heartbeat, stale worker, failed/hanging HTTP, recovery, finished, reduced motion and narrow layout. No models or real task store.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true }); }
