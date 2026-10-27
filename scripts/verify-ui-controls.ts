import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContainer } from '../server/src/bootstrap/container.js';
import { createApiServer } from '../server/src/api/http-server.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { CONNECTION_PRESETS, STANDARD_TEAM_ROLES } from '../shared/automation/presets.js';

const source = path.resolve(import.meta.dirname, '..');
const checkTemplates = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) checkTemplates(file);
    else if (/\.(?:html|ts)$/.test(entry.name)) {
      const text = readFileSync(file, 'utf8');
      assert.equal(/<select\b/i.test(text), false, `${file}: use p-select`);
      assert.equal(/<input\b[^>]*type\s*=\s*["']checkbox["']/i.test(text), false, `${file}: use p-checkbox`);
      for (const button of text.match(/<button\b[^>]*>/g) ?? []) assert.match(button, /\bpButton\b/, `${file}: use PrimeNG Button`);
    }
  }
};
checkTemplates(path.join(source, 'web', 'src'));
const root = mkdtempSync(path.join(os.tmpdir(), 'sat-controls-ui-'));
const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db'), webDistDir: path.join(source, 'dist', 'web', 'browser') }, logger: new SilentLogger() });
app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture', mergePolicy: 'local',
  connections: [{ id: 'native', label: 'Codex CLI', kind: 'native', nativeRunner: 'codex', supportsImages: false }],
  agents: STANDARD_TEAM_ROLES.map(role => ({ id: role, role, runner: 'codex', connectionId: 'native', model: 'keep-this-model', instructions: 'Keep these instructions' })),
  pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'node', args: ['--version'] }] });
const server = createApiServer(app); const browser = await chromium.launch({ headless: true });
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const open = async () => {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await page.getByRole('button', { name: 'Команда агентов', exact: true }).click();
    await page.getByRole('tab', { name: 'Команда и этапы', exact: true }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'Команда агентов' });
  const developer = dialog.getByRole('group', { name: 'Агент: Разработчик — код', exact: true });
  const connection = developer.getByRole('combobox', { name: 'Подключение агента', exact: true });
  await connection.click();
  for (const preset of CONNECTION_PRESETS) await page.getByRole('option', { name: `＋ ${preset.label} — добавить подключение`, exact: true }).waitFor();
  await page.getByRole('option', { name: '＋ Antigravity — добавить подключение', exact: true }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await developer.getByRole('combobox', { name: 'Исполнитель агента' }).getByText('Antigravity', { exact: true }).waitFor();
  // Native runner preference is a persisted field, independent of the editable label.
  await dialog.getByRole('tab', { name: 'Модели', exact: true }).click();
  await dialog.getByLabel('Имя', { exact: true }).last().fill('Командный Antigravity');
  await dialog.getByRole('button', { name: 'Сохранить настройки пространства', exact: true }).click();
  await dialog.getByText('Настройки пространства сохранены.', { exact: true }).waitFor();
  assert.equal(app.automationService.settings().connections.at(-1)?.nativeRunner, 'antigravity');
  await open();
  await connection.getByText('Командный Antigravity', { exact: true }).waitFor();
  await developer.getByRole('combobox', { name: 'Исполнитель агента' }).getByText('Antigravity', { exact: true }).waitFor();
  for (const [preset, runner] of [['Ollama', 'API (Ollama / DeepSeek / совместимый)'], ['DeepSeek API', 'API (Ollama / DeepSeek / совместимый)'], ['DeepSeek Harness', 'DeepSeek Harness'], ['Claude Code', 'Claude Code'], ['OpenCode', 'OpenCode']] as const) {
    await connection.click();
    await page.getByRole('option', { name: `＋ ${preset} — добавить подключение`, exact: true }).click();
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await developer.getByRole('combobox', { name: 'Исполнитель агента' }).getByText(runner, { exact: true }).waitFor();
  }
  await dialog.getByRole('tab', { name: 'Компьютер и проект', exact: true }).click();
  const resolver = dialog.getByRole('checkbox', { name: 'Автоматически разрешать конфликты', exact: true });
  await resolver.uncheck(); assert.equal(await resolver.isChecked(), false);
  await dialog.getByRole('button', { name: 'Сохранить настройки пространства', exact: true }).click();
  await dialog.getByText('Настройки пространства сохранены.', { exact: true }).waitFor();
  const saved = app.automationService.settings();
  assert.equal(saved.resolveConflicts, false);
  assert.equal(saved.agents.find(a => a.id === 'developer')!.model, 'keep-this-model');
  assert.equal(saved.agents.find(a => a.id === 'developer')!.instructions, 'Keep these instructions');
  assert.equal(app.automationService.list().length, 0);
  await dialog.getByRole('tab', { name: 'Команда и этапы', exact: true }).click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 2), 'Controls must fit in the dialog');
  }
  assert.equal(await page.locator('select').count(), 0);
  assert.equal(await dialog.locator('button.chip:not(.p-button)').count(), 0);
  assert.deepEqual(errors, []);
  mkdirSync(path.join(source, 'dist', 'acceptance'), { recursive: true });
  await page.screenshot({ path: path.join(source, 'dist', 'acceptance', 'sat15-controls.png'), fullPage: true });
  console.log('PASS: all app controls use PrimeNG; every provider visible from role; API/native runner mapping, renamed connection persistence, checkbox, models/instructions retained, three viewports, no runs or browser errors.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true }); }
