import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-budget-ui-'));
let now = new Date().toISOString();
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data/tracker.db'), webDistDir: path.resolve('dist/web/browser') }, clock: { now: () => now }, logger: new SilentLogger() });
const server = createApiServer(app);
const browser = await chromium.launch({ headless: true });
try {
  const service = app.automationService;
  service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', maxRunMinutes: 1,
    connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
    agents: [{ id: 'analyst', role: 'analyst', runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' }], pipeline: ['analyst'] });
  const task = app.taskService.createTask({ title: 'Budget transition fixture' });
  service.enqueue(task.id);
  const run = service.claim('fixture')!;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let writes = 0;
  page.on('request', request => { if (request.method() !== 'GET') writes++; });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.getByRole('button', { name: 'Очередь', exact: true }).click();
  await page.locator('.run-card').filter({ hasText: task.title }).click();
  await page.locator('.selected-activity .live').waitFor();
  now = new Date(Date.parse(now) + 60000).toISOString();
  service.fail(run.id, run.leaseToken!, 'Run stopped: execution time budget exhausted.');
  await page.locator('.run-stop-reason').getByText(/Исчерпан общий лимит времени/).waitFor();
  assert.equal(await page.locator('.selected-activity .live').count(), 0);
  assert.equal(await page.locator('.run-header .badge-run-status').getAttribute('data-status'), 'failed');
  const budget = page.locator('.run-budget-summary');
  const frozen = await budget.innerText();
  assert.match(frozen, /1[,.]0 из 1/);
  assert.equal(await page.getByRole('button', { name: 'Продолжить', exact: true }).isDisabled(), true);
  now = new Date(Date.parse(now) + 3600000).toISOString();
  await page.waitForTimeout(5500);
  assert.equal(await budget.innerText(), frozen, 'Terminal budget must remain frozen');
  const before = writes;
  await page.locator('.run-stop-reason').getByRole('button', { name: 'Изменить бюджет запуска' }).click();
  assert.equal(writes, before, 'Opening budget editor must not change limits or resume');
  for (const width of [390, 844]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.locator('.queue-layout').evaluate(element => element.scrollWidth <= element.clientWidth + 2));
  }
  assert.deepEqual(errors, []);
  console.log('PASS: running to failed selection, visible reason, frozen cumulative time, budget editor without mutation, narrow layout and no browser errors. Synthetic store only.');
} finally {
  await browser.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
