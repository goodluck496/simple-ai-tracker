/** UI contract scenario; metrics and selected-event responses are fixtures, not proof of server aggregation. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../shared/automation/presets.js';
import type { ImprovementMetrics } from '../shared/automation/improvement-metrics.js';

const temp = path.resolve('.sat/tmp'); mkdirSync(temp, { recursive: true });
const root = mkdtempSync(path.join(temp, 'metrics-ui-'));
const screenshots = path.resolve('.sat/screenshots'); mkdirSync(screenshots, { recursive: true });
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'), webDistDir: path.resolve('dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app);
const browser = await chromium.launch({ headless: true });
let checks = 0;
let page: Page | undefined;
try {
  const service = app.automationService;
  service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: root, connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })), pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] });
  const task = app.taskService.createTask({ title: 'Проверка контракта метрик' });
  const improvement = app.taskService.createTask({ title: 'Улучшение после сбоя' });
  const run = service.enqueue(task.id); const owned = service.claim('metrics-fixture')!;
  service.fail(run.id, owned.leaseToken!, 'Fixture CLI failure');
  const now = new Date().toISOString();
  const data: ImprovementMetrics = {
    period: { from: new Date(Date.now() - 30 * 86400000).toISOString(), to: now }, asOf: now,
    runs: 2, tasks: 1, technical: { numerator: 1, denominator: 2 }, acceptance: { numerator: 0, denominator: 1 },
    awaitingAcceptance: 1, acceptedFirstAttempt: 0, active: 0, stopped: 0, noRequiredChecks: 0, unknown: 0,
    occurrences: [{ id: 'fixture-occurrence', runId: run.id, eventId: 987654, taskId: task.id, at: now, phase: 'analyst', executor: 'OpenCode', attempt: 2, sha: 'a'.repeat(40),
      fact: 'Исполнитель завершил этап без результата.', recommendation: 'Проверить журнал исполнителя на следующем сопоставимом запуске.', improvementTaskId: improvement.id, reviewState: 'new' },
      { id: 'fixture-unlinked', runId: run.id, eventId: 987655, taskId: task.id, at: now, phase: 'checks', fact: 'Команда проверки завершилась с ошибкой.', reviewState: 'repeated_after_done' }],
  };
  await new Promise<void>(resolve => server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', resolve));
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let responseMode: 'data' | 'empty' | 'error' | 'slow' = 'data';
  let releaseSlow: (() => void) | undefined;
  let evidenceMode: 'data' | 'error' | 'slow' = 'data';
  let releaseEvidence: (() => void) | undefined;
  const periods: URL[] = [];
  await page.route('**/api/automation/metrics?*', async route => {
    periods.push(new URL(route.request().url()));
    const mode = responseMode;
    if (mode === 'slow') await new Promise<void>(resolve => { releaseSlow = resolve; });
    if (mode === 'error') { await route.fulfill({ status: 503, json: { error: { message: 'Fixture unavailable' } } }); return; }
    const payload = mode === 'empty' ? { ...data, runs: 0, tasks: 0, technical: { numerator: 0, denominator: 0 }, acceptance: { numerator: 0, denominator: 0 }, awaitingAcceptance: 0, occurrences: [] } : data;
    await route.fulfill({ json: payload }).catch(() => {});
  });
  await page.route(`**/api/automation/runs/${run.id}?eventId=*`, async route => {
    const mode = evidenceMode;
    if (mode === 'slow') await new Promise<void>(resolve => { releaseEvidence = resolve; });
    if (mode === 'error') { await route.fulfill({ status: 503, json: { error: { message: 'Source unavailable' } } }); return; }
    const response = await route.fetch(); const body = await response.json();
    assert.ok(!body.events.some((event: { id: number }) => event.id === 987654), 'Evidence must be outside the current event page');
    await route.fulfill({ json: { ...body, selectedEvent: { id: 987654, runId: run.id, at: now, kind: 'failed', text: 'Исходное CLI-событие за пределами страницы журнала.' } } });
  });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.locator('sat-sidebar button').filter({ hasText: 'Очередь задач' }).click();
  const queue = page.getByRole('dialog', { name: 'Очередь агентов' });
  await queue.getByRole('button', { name: 'Метрики', exact: true }).click();
  const metrics = queue.locator('sat-automation-metrics');
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  assert.equal(await metrics.getByText('0 / 1', { exact: true }).count(), 1);
  assert.equal(Date.parse(periods[0].searchParams.get('to')!) - Date.parse(periods[0].searchParams.get('from')!), 30 * 86400000);
  assert.equal(await metrics.getByRole('button', { name: 'Подзадача ещё не создана' }).isDisabled(), true); checks++;
  await metrics.getByRole('button', { name: 'Применить', exact: true }).click();
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  const appliedPeriod = periods.at(-1)!.search;
  await page.screenshot({ path: path.join(screenshots, 'sat55-metrics-desktop.png') });
  await metrics.getByRole('button', { name: `Открыть событие 987654 задачи ${task.id}` }).focus(); await page.keyboard.press('Enter');
  await queue.getByText('Исходное CLI-событие за пределами страницы журнала.', { exact: true }).waitFor();
  assert.equal(await queue.getByText('Причина не установлена', { exact: true }).count(), 1); checks++;
  assert.equal(await queue.locator('.evidence-context').getByText('2', { exact: true }).count(), 1);
  assert.equal(await queue.locator('.evidence-context').getByText('a'.repeat(40), { exact: true }).count(), 1);
  assert.equal(await queue.locator('#evidence-heading').evaluate(el => el === document.activeElement), true); checks++;
  await page.screenshot({ path: path.join(screenshots, 'sat55-evidence-desktop.png') });
  await queue.getByRole('button', { name: 'К метрикам', exact: true }).click();
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  assert.equal(periods.at(-1)!.search, appliedPeriod, 'Returning from an event must preserve the applied period'); checks++;
  evidenceMode = 'error';
  await metrics.getByRole('button', { name: `Открыть событие 987655 задачи ${task.id}` }).click();
  await queue.getByText(/Не удалось открыть исходное событие/).waitFor();
  assert.equal(await queue.getByText('Не записана', { exact: true }).count(), 1);
  assert.equal(await queue.getByText('Не записан', { exact: true }).count(), 1); checks++;
  evidenceMode = 'slow';
  await queue.getByRole('button', { name: 'Повторить загрузку события', exact: true }).click();
  await queue.getByText('Загрузка исходного события…', { exact: true }).waitFor(); checks++;
  evidenceMode = 'data'; releaseEvidence?.();
  await queue.getByText(/Исходное событие недоступно/).waitFor();
  assert.equal(await queue.locator('.evidence-fact').count(), 0, 'A different event must never be presented as evidence'); checks++;
  await queue.getByRole('button', { name: 'К метрикам', exact: true }).click();
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  await metrics.getByRole('button', { name: `Открыть подзадачу ${improvement.id}` }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('input')).some(input => input.value === 'Улучшение после сбоя' && input.getBoundingClientRect().width > 0)); checks++;
  // Reload closes the task card and gives each following state a clean navigation entry.
  await page.reload(); await page.locator('sat-sidebar button').filter({ hasText: 'Очередь задач' }).click();
  await queue.getByRole('button', { name: 'Метрики', exact: true }).click();
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  responseMode = 'slow'; await metrics.getByRole('button', { name: 'Обновить метрики' }).click();
  await metrics.getByText('Загрузка метрик…', { exact: true }).waitFor();
  assert.equal(await metrics.getByText('1 / 2', { exact: true }).count(), 0); checks++;
  responseMode = 'empty'; await metrics.getByRole('button', { name: 'Применить', exact: true }).click();
  await metrics.getByText('За этот период нет начатых запусков. Выберите другой период.', { exact: true }).waitFor();
  releaseSlow?.();
  assert.equal(await metrics.getByText('Нет данных', { exact: true }).count(), 2); checks++;
  responseMode = 'error'; await metrics.getByRole('button', { name: 'Обновить метрики' }).click();
  await metrics.getByRole('alert').waitFor();
  assert.equal(await metrics.getByText('Нет данных', { exact: true }).count(), 0); checks++;
  responseMode = 'data'; await metrics.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await metrics.getByText('1 / 2', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await metrics.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Dashboard must not overflow horizontally');
  await metrics.locator('.ratio-grid').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'sat55-metrics-mobile.png') }); checks++;
  await metrics.getByRole('button', { name: `Открыть событие 987654 задачи ${task.id}` }).click();
  await queue.getByText('Исходное CLI-событие за пределами страницы журнала.', { exact: true }).waitFor();
  assert.equal(await queue.locator('.selected-evidence').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Evidence must fit a narrow viewport');
  await page.screenshot({ path: path.join(screenshots, 'sat55-evidence-mobile.png') }); checks++;
  await queue.getByRole('button', { name: `Открыть подзадачу ${improvement.id}`, exact: true }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('input')).some(input => input.value === 'Улучшение после сбоя' && input.getBoundingClientRect().width > 0));
  assert.equal(await page.getByRole('button', { name: 'Продолжить запуск', exact: true }).count(), 0, 'An improvement card must not resume the source task run');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).last().click(); checks++;
  await queue.getByRole('button', { name: 'К метрикам', exact: true }).click();
  await metrics.getByRole('button', { name: 'История', exact: true }).click();
  await metrics.waitFor({ state: 'detached' });
  assert.equal(await metrics.count(), 0);
  await queue.getByRole('button', { name: 'Метрики', exact: true }).click();
  await metrics.getByRole('button', { name: 'Рабочая очередь', exact: true }).click();
  await metrics.waitFor({ state: 'detached' });
  assert.equal(await metrics.count(), 0); checks++;
  assert.deepEqual(errors, []); checks++;
  console.log(`verify-automation-metrics: exit 0, ${checks} scenario checks passed (fixture metrics API)`);
} catch (error) {
  await page?.screenshot({ path: path.join(screenshots, 'sat55-failure.png') });
  console.error('Current UI buttons:', await page?.getByRole('button').allTextContents());
  throw error;
} finally {
  await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); app.close();
  if (root.startsWith(temp + path.sep)) rmSync(root, { recursive: true, force: true });
}
