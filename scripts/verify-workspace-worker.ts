import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { HostStatus } from '../shared/automation/project.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { createContainer } from '../server/src/bootstrap/container.js';
import { SilentLogger } from '../server/src/core/logger.js';

const appRoot = path.resolve(import.meta.dirname, '..');
const root = mkdtempSync(path.join(os.tmpdir(), 'sat-workspace-worker-'));
const app = createContainer({ config: { appRoot: root, backupEnabled: false, webDistDir: path.join(appRoot, 'dist', 'web', 'browser') }, logger: new SilentLogger() });
const server = createApiServer(app);
const run = promisify(execFile);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const service = (...args: string[]) => run(process.execPath, ['scripts/worker-service.mjs', ...args, '--local'], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, SAT_HOME: root, SAT_DB_PATH: undefined, SAT_WORKSPACE: undefined,
    SAT_MCP_COMMAND: undefined, SAT_MCP_ARGS: undefined, LOCALAPPDATA: root },
});

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for workspace worker');
}

try {
  mkdirSync(path.join(root, 'scripts'));
  cpSync(path.join(appRoot, 'scripts', 'worker-service.mjs'), path.join(root, 'scripts', 'worker-service.mjs'));
  cpSync(path.join(appRoot, 'dist', 'server'), path.join(root, 'dist', 'server'), { recursive: true });
  symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async <T>(endpoint: string, workspace: string, body?: object): Promise<T> => {
    const response = await fetch(`${base}/api/${endpoint}`, {
      headers: { 'X-Tracker-Workspace': workspace, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    assert.ok(response.ok, `${endpoint}: ${response.status}`);
    return await response.json() as T;
  };
  const host = (workspace: string) => request<HostStatus>('automation/host', workspace);
  await service('start', '--workspace', 'default', '--discovered-workspace');
  const original = await waitFor(() => host('default'), status => status.online);
  await request('workspaces', 'default', { name: 'new-project' });
  const connected = await waitFor(() => host('new-project'), status => status.online);
  assert.notEqual(connected.workerId, original.workerId);
  assert.equal((await host('default')).workerId, original.workerId);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => sessionStorage.setItem('sat.workspace', 'new-project'));
  await page.route('**/api/auth/status', route => route.fulfill({ json: { enabled: false } }));
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let holdConnectionStatus = true;
  await page.route('**/api/automation/host', route => holdConnectionStatus ? route.fulfill({ json: { online: false } }) : route.continue());
  await page.goto(`${base}/automation/settings/project`);
  const picker = page.locator('p-button[data-project-picker] button').filter({ hasText: 'Выбрать проект' });
  await picker.click().catch(async error => {
    console.error({ url: page.url(), pageErrors, body: (await page.locator('body').innerText()).slice(0, 1200) });
    throw error;
  });
  const connection = page.getByRole('dialog', { name: 'Подключить компьютер для выбора папки' });
  await connection.waitFor();
  assert.equal(await connection.getByRole('textbox').count(), 0);
  await connection.getByRole('button', { name: 'Подключить вручную' }).click();
  assert.match(await connection.getByRole('textbox').inputValue(), /new-project/);
  holdConnectionStatus = false;
  await page.getByRole('group', { name: 'Папки на компьютере воркера' }).waitFor();
  await connection.waitFor({ state: 'hidden' });
  console.log('PASS: a new workspace can browse worker folders without restarting the original host.');
  const folders = page.getByRole('group', { name: 'Папки на компьютере воркера' });
  await folders.locator('button').filter({ hasText: 'Закрыть' }).click();
  const repo = path.join(root, 'fixture');
  for (const appName of ['web', 'api']) {
    const directory = path.join(repo, appName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { build: `echo ${appName}-fixture` } }));
  }
  await run('git', ['init', '-b', 'main'], { cwd: repo });
  const projectInput = page.getByRole('textbox', { name: /Папка проекта или package.json/ });
  await projectInput.fill(repo);
  await picker.click();
  const web = folders.getByRole('treeitem', { name: 'web', exact: true });
  await web.locator('button').first().click();
  await folders.getByText('package.json', { exact: true }).click();
  await folders.locator('button').filter({ hasText: 'Использовать для проекта' }).click();
  await page.getByText('Проект прочитан на worker. Выберите ветку и команды из package.json.').waitFor();
  assert.equal(await projectInput.inputValue(), path.join(repo, 'web'));
  await page.getByRole('button', { name: 'Сохранить настройки проекта' }).click();
  await page.getByText('Настройки проекта сохранены.', { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(expected => (document.querySelector('.folder-input-row input') as HTMLInputElement)?.value === expected, path.join(repo, 'web'));
  assert.deepEqual(pageErrors, []);
  console.log('PASS: selected a nested package.json and reloaded the saved project directory.');
} finally {
  await browser?.close();
  await service('stop');
  await new Promise<void>(resolve => server.close(() => resolve()));
  app.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
}
