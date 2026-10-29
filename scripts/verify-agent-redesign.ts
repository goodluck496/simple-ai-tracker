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

const root = mkdtempSync(path.join(os.tmpdir(), 'sat-agent-redesign-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'fixture.db'), webDistDir: path.resolve(process.env.SAT_WEB_DIST ?? 'dist/web/browser') }, logger: new SilentLogger() });
const server = createApiServer(app), browser = await chromium.launch({ headless: true });
try {
  app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
    connections: [{ id: 'native', label: 'Fixture', kind: 'native', supportsImages: false }],
    agents: (['developer', 'tester'] as const).map(role => ({ id: role, role, runner: 'codex', connectionId: 'native', model: 'fixture', instructions: '' })),
    pipeline: ['developer', 'tester'], checks: [{ command: 'node', args: ['--version'] }] });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.getByRole('button', { name: 'Команда агентов', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Команда агентов', exact: true });
  await dialog.locator('.panel-layout').waitFor();
  await page.waitForTimeout(300); // Wait for PrimeNG's dialog entrance animation before measuring.
  const original = (await dialog.boundingBox())!;
  for (const label of ['Запуск', 'Команда и этапы', 'Модели', 'Проект и проверки']) {
    await dialog.locator('.panel-sidebar .nav-item').filter({ hasText: label }).click();
    const box = (await dialog.boundingBox())!;
    assert.ok(Math.abs(box.width - original.width) < 2 && Math.abs(box.height - original.height) < 2, `Modal geometry stays fixed on ${label}: ${JSON.stringify({ original, box })}`);
    assert.ok(await dialog.locator('.sidebar-footer').evaluate(element => {
      const color = getComputedStyle(element).backgroundColor;
      return color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color);
    }), 'Save footer has an opaque background');
  }
  const [saved] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/automation/')),
    dialog.locator('.sidebar-footer button').click(),
  ]);
  assert.ok(saved.ok(), 'Settings save succeeds');
  await dialog.locator('.panel-sidebar .nav-item').filter({ hasText: 'Команда и этапы' }).click();
  mkdirSync('dist/acceptance', { recursive: true });
  await page.screenshot({ path: 'dist/acceptance/agent-redesign.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: restored sidebar redesign, four sections, fixed modal size, opaque footer and settings save; no browser errors. Synthetic data only.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
