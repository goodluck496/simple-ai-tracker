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

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-queue-search-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'),
  webDistDir: path.resolve(import.meta.dirname, '../dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app);
const browser = await chromium.launch({ headless: true });
try {
  const settings = { ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: '/fixture',
    connections: [{ id: 'native', label: 'Fixture', kind: 'native' as const, supportsImages: false }],
    agents: (['analyst', 'developer', 'tester', 'reviewer'] as const).map(role => ({ id: role, role,
      runner: 'codex' as const, connectionId: 'native', model: 'fixture', instructions: '' })),
    pipeline: ['analyst', 'developer', 'tester', 'reviewer'], checks: [{ command: 'node', args: ['--version'] }] };
  app.automationService.configure(settings);
  const runs = Array.from({ length: 120 }, (_, i) => {
    const task = app.taskService.createTask({ title: i === 73 ? 'Special   Fixture Title' : `Fixture ${i}` });
    return app.automationService.enqueue(task.id);
  });
  app.workspaceManager.create('isolated', 'Isolated');
  app.workspaceManager.within('isolated', () => {
    app.automationService.configure(settings);
    const task = app.taskService.createTask({ title: 'Isolated only' }); app.automationService.enqueue(task.id);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.getByRole('button', { name: 'Очередь', exact: true }).click();
  const queue = page.getByRole('dialog', { name: 'Очередь агентов' });
  const cards = queue.locator('.run-card'); await cards.nth(119).waitFor();
  const list = queue.locator('.lane-items').first();
  assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight));
  await list.evaluate(el => { el.scrollTop = 350; });
  const before = await list.evaluate(el => el.scrollTop);
  const nextPoll = page.waitForResponse(r => r.url().endsWith('/api/automation/queue'));
  await nextPoll;
  assert.ok(Math.abs(await list.evaluate(el => el.scrollTop) - before) <= 2, 'poll preserves list scroll');
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.ok(await list.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2));
  const search = queue.getByRole('searchbox', { name: 'Поиск запусков' });
  await search.fill('  special   fixture title '); await cards.first().waitFor(); assert.equal(await cards.count(), 1);
  await search.fill(runs[73].id.toUpperCase()); assert.equal(await cards.count(), 1);
  await search.fill(runs[73].taskId.toLowerCase()); assert.equal(await cards.count(), 1);
  await search.fill('no-such-fixture'); await queue.getByText('Нет совпадений', { exact: true }).first().waitFor();
  await queue.getByRole('button', { name: 'Очистить поиск', exact: true }).click(); assert.equal(await cards.count(), 120);
  await search.focus(); await page.keyboard.type('special'); assert.equal(await cards.count(), 1);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport); assert.ok(await queue.evaluate(el => el.scrollWidth <= el.clientWidth + 2));
  }
  // Workspace activation uses full reload; verify the same persisted selection path without touching live data.
  await page.evaluate(() => sessionStorage.setItem('sat.workspace', 'isolated')); await page.reload();
  await page.getByRole('button', { name: 'Очередь', exact: true }).click();
  await queue.getByRole('button', { name: /Запуск/ }).first().waitFor();
  assert.equal(await search.inputValue(), ''); assert.equal(await cards.count(), 1);
  await cards.first().getByText(/Isolated only/).waitFor();
  assert.equal(await queue.getByRole('article', { name: 'Детали запуска' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: 120 runs, bounded scroll/poll retention, normalized search/clear/keyboard, responsive widths and workspace isolation');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
