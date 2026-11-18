import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {chromium} from 'playwright';
import {createContainer} from '../server/src/bootstrap/container.js';
import {createApiServer} from '../server/src/api/http-server.js';
import {SilentLogger} from '../server/src/core/logger.js';
import {DEFAULT_AUTOMATION_SETTINGS} from '../shared/automation/contracts.js';

const root=mkdtempSync(path.join(os.tmpdir(),'sat-routing-ui-'));
const output=path.resolve('.sat/screenshots');mkdirSync(output,{recursive:true});
const app=createContainer({config:{appRoot:root,dbPath:path.join(root,'fixture.db'),webDistDir:path.resolve('dist/web/browser')},logger:new SilentLogger()});
const roles=['router','analyst','developer','tester','reviewer'] as const;
app.automationService.configure({...structuredClone(DEFAULT_AUTOMATION_SETTINGS),repositoryPath:'/fixture',
  connections:[{id:'native',label:'Fixture',kind:'native',nativeRunner:'codex',supportsImages:false}],
  agents:roles.map(role=>({id:role,role,runner:'codex',connectionId:'native',model:'fixture-model',instructions:''})),
  pipeline:roles.filter(role=>role!=='router'),checks:[{command:'node',args:['--version']}],
  pipelineRoutes:[{from:'tester',passTo:'reviewer',retry:{to:'developer',limit:1,exhausted:'stop'}},{from:'reviewer',passTo:null}]});
const server=createApiServer(app);const browser=await chromium.launch({headless:true});
const started=Date.now();
try {
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  await context.tracing.start({screenshots:true,snapshots:true});
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const expand=page.getByRole('button',{name:'Развернуть',exact:true}); if(await expand.isVisible()) await expand.click();
  await page.locator('sat-sidebar').getByText('Команда агентов',{exact:true}).click();
  await page.getByRole('dialog',{name:'Команда агентов'}).getByText('Команда и этапы',{exact:true}).click();
  await page.getByRole('button',{name:'Добавить этап',exact:true}).click();
  await page.getByRole('combobox',{name:'Агент для нового этапа',exact:true}).click();
  await page.getByRole('option',{name:'Роутер · fixture-model',exact:true}).click();
  await page.getByRole('button',{name:'Добавить в маршрут',exact:true}).click();
  await page.locator('.route-step').first().getByText('Роутер',{exact:true}).waitFor();
  assert.equal(await page.locator('.route-error').count(),0);
  await page.getByText('Разрешённые профили моделей',{exact:true}).waitFor();
  const select=page.getByRole('combobox',{name:'Разрешённые профили моделей'});
  await page.locator('sat-task-routing p-multiselect').click();
  await page.getByRole('option',{name:'developer · fixture-model · developer',exact:true}).click();
  await page.getByText('Подготовка задачи и выбор моделей',{exact:true}).click();
  await page.getByText('Worker запускает тестовое приложение',{exact:true}).click();
  await page.getByPlaceholder('npm',{exact:true}).fill('node');
  await page.getByRole('textbox',{name:'Аргументы',exact:true}).fill('["server.mjs","--port","{port}"]');
  await page.getByRole('textbox',{name:'Путь готовности',exact:true}).fill('/health');
  await page.getByRole('button',{name:'Сохранить настройки проекта',exact:true}).click();
  await page.getByText('Настройки проекта сохранены.',{exact:true}).waitFor();
  assert.deepEqual(app.automationService.settings().routingProfileIds,['developer']);
  assert.equal(app.automationService.settings().pipeline[0],'router');
  assert.equal(app.automationService.settings().pipelineRoutes?.find(r=>r.from==='reviewer')?.passTo,null);
  assert.equal(app.automationService.settings().pipelineRoutes?.find(r=>r.from==='tester')?.retry?.to,'developer');
  assert.equal(app.automationService.settings().browser?.readyPath,'/health');

  // Reproduce the old in-memory draft: trailing router and reviewer -> router terminal link.
  const legacy=structuredClone(app.automationService.settings());
  legacy.pipeline=[...legacy.pipeline.filter(id=>id!=='router'),'router'];
  legacy.pipelineRoutes!.find(r=>r.from==='reviewer')!.passTo='router';
  await page.route('**/api/automation/settings',async route=>{
    if(route.request().method()==='GET') await route.fulfill({json:legacy}); else await route.continue();
  });
  await page.reload();
  await page.locator('sat-sidebar').getByText('Команда агентов',{exact:true}).click();
  await page.getByRole('dialog',{name:'Команда агентов'}).getByText('Команда и этапы',{exact:true}).click();
  await page.locator('.route-step').last().locator('.p-step-header').click();
  await page.getByRole('combobox',{name:'Позиция',exact:true}).click();
  await page.getByRole('option',{name:'1',exact:true}).click();
  await page.locator('.route-step').first().getByText('Роутер',{exact:true}).waitFor();
  assert.equal(await page.locator('.route-error').count(),0);
  await page.getByRole('button',{name:'Сохранить настройки проекта',exact:true}).click();
  await page.getByText('Настройки проекта сохранены.',{exact:true}).waitFor();
  assert.equal(app.automationService.settings().pipeline[0],'router');
  assert.equal(app.automationService.settings().pipelineRoutes?.find(r=>r.from==='reviewer')?.passTo,undefined);
  assert.equal(app.automationService.settings().pipelineRoutes?.find(r=>r.from==='tester')?.retry?.to,'developer');

  await page.screenshot({path:path.join(output,'routing-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  const closeNav=page.getByText('Показать содержимое',{exact:true}); await closeNav.waitFor({state:'visible'}); await closeNav.click(); await page.locator('sat-automation-panel .panel-sidebar.collapsed').waitFor({state:'hidden'});
  const dialog=page.getByRole('dialog',{name:'Команда агентов'});
  assert.ok(await page.locator('sat-task-routing').first().evaluate(el=>el.getBoundingClientRect().width>240),'routing content remains readable on mobile');
  assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+2),'dialog fits mobile');
  await page.screenshot({path:path.join(output,'routing-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  await context.tracing.stop({path:path.resolve('.sat/routing-ui-trace.zip')});
  const metrics={scenario:'routing-settings-browser',passed:true,durationMs:Date.now()-started,viewports:['1440x1100','390x844'],pageErrors:errors.length,modelCalls:0};
  writeFileSync(path.resolve('.sat/routing-ui-metrics.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics));
} catch(error) { const page=browser.contexts()[0]?.pages()[0]; if(page) { console.log((await page.locator('body').innerText()).slice(0,2500)); await page.screenshot({path:path.join(output,'routing-failure.png'),fullPage:true}); } throw error; } finally {await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));app.close();rmSync(root,{recursive:true,force:true,maxRetries:3});}
