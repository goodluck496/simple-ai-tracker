import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
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
  const sidebarToggle = page.locator('sat-sidebar .sidebar-toggle-btn');
  await sidebarToggle.waitFor();
  if (await sidebarToggle.getAttribute('aria-label') === 'Развернуть') await sidebarToggle.click();
  await page.locator('sat-sidebar button').filter({hasText:'Команда агентов'}).click();
  const dialog = page.getByRole('dialog', { name: 'Команда агентов', exact: true });
  await dialog.locator('.panel-layout').waitFor();
  await page.waitForTimeout(300); // Wait for PrimeNG's dialog entrance animation before measuring.
  const original = (await dialog.boundingBox())!;
  for (const label of ['Запуск', 'Команда и этапы', 'Навыки и MCP', 'Модели', 'Проект и проверки']) {
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
  const tab = (name:string) => dialog.locator('.panel-sidebar .nav-item').filter({hasText:name}).click();
  await tab('Навыки и MCP');
  const library = dialog.getByRole('region', { name: 'Навыки проекта' });
  await library.getByRole('button', { name: 'Создать навык' }).click();
  const editor = page.getByRole('dialog', { name: 'Новый общий навык' });
  await editor.getByLabel('Название').fill('Проверка сохранения');
  await editor.getByLabel('Когда применять').fill('При изменении сохранения данных.');
  await editor.getByLabel('Инструкция').fill('Проверь значение после повторного открытия.');
  await editor.getByRole('button', { name: 'Сохранить в библиотеку' }).click();
  const row = library.locator('article').filter({hasText: 'Проверка сохранения'});
  await library.getByRole('textbox', {name:'Поиск по навыкам'}).fill('изменении сохранения');
  assert.equal(await library.locator('article').count(), 1);
  await row.getByRole('checkbox').check();
  await dialog.getByRole('button', {name:'Добавить MCP'}).click();
  const mcp = page.getByRole('dialog', {name:'Подключение MCP'});
  await mcp.getByRole('button', {name:'Playwright · браузер'}).click();
  await expect(mcp.getByLabel('Команда на воркере')).toHaveValue('npx');
  await expect(mcp.getByLabel('Разрешённые инструменты через запятую')).toHaveValue(/browser_take_screenshot/);
  await mcp.getByRole('button', {name:'GitHub · ревью'}).click();
  await expect(mcp.getByLabel('Переменная воркера с bearer-токеном')).toHaveValue('GITHUB_PERSONAL_ACCESS_TOKEN');
  let registryName = 'sample';
  await page.route('https://registry.modelcontextprotocol.io/v0.1/servers?**', route => route.fulfill({json:{
    servers:[{server:{name:'org.example/' + registryName,remotes:[{type:'streamable-http',url:'https://example.org/mcp'}]}},
      {server:{name:'org.example/local',packages:[]}}],metadata:{}}}));
  await mcp.getByRole('button', {name:'Поиск по реестру MCP'}).click();
  await mcp.getByLabel('Поиск в официальном реестре MCP').fill('example');
  await mcp.getByRole('button', {name:'Найти MCP'}).click();
  await mcp.getByText('Требуется ручная настройка подключения.').waitFor();
  await mcp.getByRole('button', {name:'Выбрать сервер'}).click();
  await mcp.getByLabel('Поиск в официальном реестре MCP').waitFor({state:'hidden'});
  await expect(mcp.getByLabel('URL сервера (Streamable HTTP)')).toHaveValue('https://example.org/mcp');
  await expect(mcp.getByLabel('Переменная воркера с bearer-токеном')).toHaveValue('');
  await mcp.getByRole('button', {name:'Добавить без инструментов'}).click();
  await mcp.waitFor({state:'hidden'});
  await expect(dialog.locator('.row').filter({hasText:'sample'})).toContainText('Инструменты не выбраны');
  await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/automation/settings')),
    dialog.locator('.sidebar-footer button').click()]);
  const pending = app.automationService.settings().mcpServers!.find(s => s.name === 'sample')!;
  assert.deepEqual(pending.tools, []);
  assert.deepEqual(pending.roles, []);
  assert.throws(() => app.automationService.configure({...app.automationService.settings(),mcpServers:[{...pending,roles:['developer']}]}));

  app.automationService.projects.poll('fixture-host');
  registryName = 'online-search';
  await dialog.getByRole('button', {name:'Добавить MCP'}).click();
  await expect(mcp.getByRole('button', {name:'Получить инструменты с воркера'})).toBeEnabled({timeout:20000});
  await mcp.getByRole('button', {name:'Поиск по реестру MCP'}).click();
  await mcp.getByLabel('Поиск в официальном реестре MCP').fill('example');
  await mcp.getByRole('button', {name:'Найти MCP'}).click();
  await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/automation/project-requests')),
    mcp.getByRole('button', {name:'Выбрать сервер'}).click()]);
  const probe = app.automationService.projects.poll('fixture-host')!;
  assert.equal(probe.action,'probe-mcp');
  assert.equal(probe.path,'');
  assert.equal(probe.mcp?.name,registryName);
  app.automationService.projects.complete(probe.id,probe.token!,{path:'',mcpTools:['lookup','write']});
  await mcp.locator('p-multiselect').click();
  await page.getByRole('option',{name:'lookup',exact:true}).click();
  await mcp.getByLabel('Имя MCP').click();
  await mcp.getByRole('button', {name:'Применить подключение'}).click();
  await mcp.waitFor({state:'hidden'});
  await dialog.getByRole('button', {name:'Добавить MCP'}).click();
  await mcp.getByRole('button', {name:'Своя настройка'}).click();
  await mcp.getByLabel('Имя MCP').fill('fixture-search');
  await mcp.getByLabel('Команда на воркере').fill('node');
  await mcp.getByLabel('Аргументы команды (массив JSON)').fill('["server.mjs"]');
  await mcp.getByLabel('Разрешённые инструменты через запятую').fill('lookup');
  await mcp.getByRole('button', {name:'Применить подключение'}).click();
  await tab('Команда и этапы');
  const developer = dialog.locator('.agent-config-card').filter({has:page.locator('.agent-role-badge').filter({hasText:'Разработчик'})}).first();
  await developer.locator('label').filter({hasText:'Навыки роли'}).locator('p-multiselect').click();
  await page.getByRole('option', {name:'Проверка сохранения'}).click();
  await developer.locator('.agent-role-badge').click();
  await developer.locator('label').filter({hasText:'MCP роли'}).locator('p-multiselect').click();
  assert.equal(await page.getByRole('option',{name:'sample',exact:true}).count(), 0);
  await page.getByRole('option', {name:'fixture-search'}).click();
  await developer.locator('.agent-role-badge').click();
  await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/automation/settings')),
    dialog.locator('.sidebar-footer button').click(),
  ]);
  const skill = app.automationService.skillLibrary.list().find(item => item.name === 'Проверка сохранения')!;
  assert.deepEqual(app.automationService.settings().skillBindings, [{skillId:skill.id,roles:['developer']}]);
  assert.deepEqual(app.automationService.settings().mcpServers?.find(s => s.name === 'fixture-search')?.roles, ['developer']);
  assert.deepEqual(app.automationService.settings().mcpServers?.find(s => s.name === 'online-search')?.tools, ['lookup']);
  await tab('Навыки и MCP');
  await row.getByRole('button', {name:'Редактировать Проверка сохранения'}).click();
  const update = page.getByRole('dialog', {name:'Изменить общий навык'});
  await update.getByLabel('Инструкция').fill('Перезапусти клиент и проверь сохранённое значение.');
  await update.getByRole('button', {name:'Сохранить в библиотеку'}).click();
  await update.waitFor({state:'hidden'});
  assert.equal(app.automationService.skillLibrary.list().find(item => item.id === skill.id)?.version, 2);
  const repo = 'https://api.github.com/repos/obra/superpowers/git';
  await page.route(repo + '/trees/HEAD?recursive=1', route => route.fulfill({json:{tree:[
    {path:'skills/example/SKILL.md',sha:'unused',type:'blob',mode:'100644'},
    {path:'skills/test-driven-development/SKILL.md',sha:'abc',type:'blob',mode:'100644'}]}}));
  await page.route(repo + '/blobs/abc', route => route.fulfill({contentType:'text/plain',body:'---\nname: imported-example\ndescription: >\n  Test an external instruction\n---\nUse the test fixture.'}));
  await library.getByRole('button', {name:'Каталоги и импорт'}).click();
  const importer = page.getByRole('dialog',{name:'Импорт навыка'});
  await importer.getByRole('button',{name:'Superpowers · разработка и тесты'}).click();
  await importer.getByRole('button',{name:'Открыть инструкцию'}).click();
  assert.equal(await editor.getByLabel('Когда применять').inputValue(), 'Test an external instruction');
  await editor.getByRole('button',{name:'Сохранить в библиотеку'}).click();
  await editor.waitFor({state:'hidden'});
  const imported = app.automationService.skillLibrary.list().find(s => s.name === 'imported-example')!;
  assert.equal(app.automationService.skillLibrary.read(imported).sourceUrl, repo + '/blobs/abc');
  await tab('Команда и этапы');
  const baseTeam = dialog.getByRole('region', {name:'Базовая команда'});
  await baseTeam.getByRole('button', {name:'Сохранить как базовую'}).click();
  await baseTeam.getByRole('button', {name:'Сохранить для всех проектов'}).click();
  await baseTeam.getByText('У проекта своя команда.', {exact:false}).waitFor();
  app.workspaceManager.create('inherits');
  app.workspaceManager.within('inherits', () => {
    const inherited = app.automationService.settings();
    assert.deepEqual(inherited.skillBindings, [{skillId:skill.id, roles:['developer']}]);
    assert.deepEqual(inherited.mcpServers?.find(s => s.name === 'fixture-search')?.tools, ['lookup']);
    assert.equal(inherited.repositoryPath, '');
  });
  await baseTeam.getByRole('button', {name:'Вернуть базовую команду'}).click();
  await dialog.locator('.sidebar-footer button').click();
  await baseTeam.getByText('Проект наследует базовую команду.', {exact:true}).waitFor();
  await developer.getByText('Инструкции роли', {exact:true}).click();
  const instruction = developer.locator('textarea.instructions-textarea');
  const originalText = await instruction.inputValue();
  await instruction.fill('Инструкция только для проекта');
  await dialog.locator('.sidebar-footer button').click();
  await baseTeam.getByText('Проект наследует базовую команду с локальными изменениями.').waitFor();
  await developer.getByRole('button', {name:'Вставить базовую инструкцию'}).click();
  assert.equal(await instruction.inputValue(), originalText);
  await dialog.locator('.sidebar-footer button').click();
  await baseTeam.getByText('Проект наследует базовую команду.', {exact:true}).waitFor();
  mkdirSync('dist/acceptance', { recursive: true });
  await page.screenshot({ path: 'dist/acceptance/agent-redesign.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: settings layout, library search and import, MCP, shared team publication, inheritance and reset.');
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  app.close(); rmSync(root, { recursive: true, force: true });
}
