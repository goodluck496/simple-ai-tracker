import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../shared/automation/presets.js';
import { formatQueueDate } from '../web/src/app/components/automation-queue/queue-dates.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-console-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'),
  webDistDir: path.resolve(import.meta.dirname, '../dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const service = app.automationService;
  service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map((role) => ({ id: role, role, runner: 'codex', model: 'fixture', instructions: '', connectionId: 'fixture' })),
    pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] });
  const task = app.taskService.createTask({ title: 'Console fixture' }); service.enqueue(task.id);
  const run = service.claim('fixture')!; service.beginStage(run.id, run.leaseToken!);
  const otherTask = app.taskService.createTask({ title: 'Other console fixture' }); const other = service.enqueue(otherTask.id);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(); page.setDefaultTimeout(18000);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.getByRole('button', { name: 'Очередь', exact: true }).click();
  const queue = page.getByRole('dialog', { name: 'Очередь агентов' });
  await queue.getByRole('button', { name: `Запуск ${task.id} ${run.id}`, exact: true }).click();
  const consoleView = queue.getByRole('region', { name: 'Консоль выполнения' });
  const log = consoleView.getByRole('log');
  const timestamps = queue.locator('.run-timestamps dd');
  await timestamps.first().waitFor();
  const displayed = service.detail(run.id).run;
  assert.deepEqual(await timestamps.allTextContents(), [displayed.createdAt, displayed.startedAt, displayed.attemptStartedAt, undefined, displayed.updatedAt].map(value => formatQueueDate(value)));
  const payload = JSON.stringify({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'npm test',
    aggregated_output: 'PRIVATE_SOURCE_SENTINEL\r\n<img src=x onerror=alert(1)>\n', stderr: 'Error: fixture stderr\n', exit_code: 1 } });
  service.progress(run.id, run.leaseToken!, payload.slice(0, 65));
  await consoleView.getByRole('status').filter({ hasText: 'часть структурированной записи' }).waitFor();
  service.progress(run.id, run.leaseToken!, payload.slice(65) + '\n');
  await log.getByText('Команда: npm test → exit 1.', { exact: true }).waitFor();
  assert.equal(await log.getByText('Команда: npm test → exit 1.', { exact: true }).count(), 1);
  assert.ok(!(await log.innerText()).includes('PRIVATE_SOURCE_SENTINEL'));
  assert.equal(await log.locator('img').count(), 0);
  assert.ok(!(await log.innerText()).includes('item.completed'));
  assert.ok((await log.innerText()).includes('exit 1'));
  const select = async (name: string, label: string) => {
    await consoleView.getByRole('combobox', { name, exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
  };
  await select('Уровень журнала', 'Ошибки');
  assert.equal(await log.locator('.line:not([data-level="error"])').count(), 0);
  await consoleView.getByRole('button', { name: 'Копировать вывод', exact: true }).click();
  await consoleView.getByRole('status').filter({ hasText: 'скопирован' }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /fixture stderr/); assert.doesNotMatch(copied, /\$ npm test/);
  await select('Уровень журнала', 'Все');
  await select('Этап журнала', 'Подготовка');
  assert.ok(!(await log.innerText()).includes('$ npm test'));
  await select('Этап журнала', 'Все этапы');
  await consoleView.locator('summary').click();
  assert.match(await consoleView.locator('.raw').innerText(), /item.completed/);
  const [download] = await Promise.all([page.waitForEvent('download'), consoleView.getByRole('button', { name: 'Скачать полный исходный журнал', exact: true }).click()]);
  const downloaded = readFileSync((await download.path())!, 'utf8');
  const raw = downloaded.trim().split('\n').map((line) => JSON.parse(line) as { kind: string; text: string });
  assert.ok(raw.filter((entry) => entry.kind === 'progress').map((entry) => entry.text).join('').includes(payload));
  await consoleView.locator('summary').click();
  service.progress(run.id, run.leaseToken!, Array.from({ length: 90 }, (_, i) => `scroll fixture ${i}\n`).join(''));
  await log.getByText('scroll fixture 89', { exact: true }).waitFor();
  await log.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await consoleView.getByText(/Автопрокрутка приостановлена/).waitFor();
  service.progress(run.id, run.leaseToken!, 'latest marker\n');
  await log.getByText('latest marker', { exact: true }).waitFor();
  assert.equal(await log.evaluate((element) => element.scrollTop), 0);
  await consoleView.getByRole('button', { name: 'К последним строкам', exact: true }).click();
  await page.waitForFunction(() => { const element = document.querySelector('[aria-label="Вывод выполнения"]')!; return element.scrollHeight - element.scrollTop - element.clientHeight < 24; });
  service.progress(run.id, run.leaseToken!, Array.from({ length: 650 }, (_, i) => `bounded fixture ${i}\n`).join(''));
  await log.getByText('bounded fixture 649', { exact: true }).waitFor();
  assert.equal(await log.locator('.line').count(), 600);
  assert.ok(!(await queue.locator('.run-detail > p.summary').allTextContents()).join('').includes('bounded fixture'), 'Raw progress must not be duplicated above the console');
  await consoleView.getByText(/Скрыто строк:/).waitFor();
  await queue.getByRole('button', { name: `Запуск ${otherTask.id} ${other.id}`, exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Вывод выполнения"]')?.textContent?.includes('bounded fixture'));
  assert.ok(!(await consoleView.innerText()).includes('Автопрокрутка приостановлена'));
  service.cancel(run.id);
  await queue.getByRole('button', { name: `Запуск ${task.id} ${run.id}`, exact: true }).click();
  await queue.getByRole('article', { name: 'Детали запуска' }).getByText('Остановлен · карточка: Планирование', { exact: true }).waitFor();
  const stopped = service.detail(run.id).run;
  assert.ok(stopped.finishedAt);
  assert.equal(await timestamps.nth(3).textContent(), formatQueueDate(stopped.finishedAt));
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth + 2), 'Console must stay inside narrow dialog');
  }
  assert.deepEqual(errors, []);
  const artifacts = path.resolve(import.meta.dirname, '../dist/acceptance'); mkdirSync(artifacts, { recursive: true });
  await consoleView.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'run-console.png'), fullPage: true });
  console.log('PASS: split JSONL, readable console, errors/stage filters, Unicode/ANSI, safe text, copy/download, bounded rows, scroll, run switch, cancellation, responsive layout.');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
