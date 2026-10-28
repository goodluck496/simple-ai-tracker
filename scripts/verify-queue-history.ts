import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../shared/automation/presets.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-history-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'), webDistDir: path.resolve('dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app); const browser = await chromium.launch({ headless: true });
try {
  const service = app.automationService;
  service.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', connections: [{ id: 'n', label: 'Native', kind: 'native', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map(role => ({ id: role, role, runner: 'codex', connectionId: 'n', model: 'fixture', instructions: '' })), pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] });
  const task = app.taskService.createTask({ title: 'Accepted task with failed attempts' });
  const failed = service.enqueue(task.id); const owned = service.claim('fixture')!;
  service.fail(failed.id, owned.leaseToken!, 'fixture budget failure');
  app.taskService.setStatus({ id: task.id, status: 'review', actor: 'user' });
  const next = app.taskService.createTask({ title: 'Pending work' }); const pending = service.enqueue(next.id);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(18000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.getByRole('button', { name: 'Очередь', exact: true }).click();
  const queue = page.getByRole('dialog', { name: 'Очередь агентов' });
  const failedCard = queue.getByRole('button', { name: `Запуск ${task.id} ${failed.id}`, exact: true });
  await queue.getByRole('button', { name: `Запуск ${next.id} ${pending.id}`, exact: true }).waitFor();
  assert.equal(await failedCard.count(), 0, 'Terminal attempts must not remain in the working queue');
  await queue.getByRole('button', { name: 'История запусков', exact: true }).click(); await failedCard.click();
  assert.equal(await queue.getByRole('button', { name: 'Продолжить с места остановки', exact: true }).count(), 0, 'Accepted tasks cannot resume');
  const detail = queue.getByRole('article', { name: 'Детали запуска' });
  await detail.getByRole('button', { name: 'Очистить файлы', exact: true }).click();
  const confirmation = queue.getByRole('region', { name: 'Подтверждение удаления' });
  assert.equal(await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).isEnabled(), false);
  await confirmation.locator('#discard-run').check();
  await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.run-detail')?.textContent?.includes('ожидает host worker'));
  const request = service.projects.poll('fixture-host')!;
  assert.equal(request.action, 'cleanup');
  service.completeHost(request.id, request.token!, { path: '/fixture', cleanup: { paths: [], branches: [], retainedBranches: [] } });
  await detail.getByText(/файлы очищены, история сохранена/).waitFor();
  await detail.getByRole('button', { name: 'Удалить запуск навсегда', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(service.detail(failed.id).run.id, failed.id, 'Cancellation keeps the journal');
  await detail.getByRole('button', { name: 'Удалить запуск навсегда', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Подтвердить', exact: true }).click(); await failedCard.waitFor({ state: 'hidden' });
  assert.equal(app.taskService.getTaskCard(task.id).status, 'review');
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await queue.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
  }
  assert.deepEqual(errors, []);
  console.log('PASS: active queue, task history, accepted-task guard, PrimeNG discard confirmation, cleanup acknowledgement, permanent delete/cancel, responsive. No models or real task store used.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true });
}
