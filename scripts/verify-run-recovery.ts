import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {chromium} from 'playwright';
import {createContainer} from '../server/src/bootstrap/container.js';
import {createApiServer} from '../server/src/api/http-server.js';
import {SilentLogger} from '../server/src/core/logger.js';
import {DEFAULT_AUTOMATION_SETTINGS} from '../shared/automation/contracts.js';

const root=mkdtempSync(path.join(os.tmpdir(),'sat-recovery-ui-'));
const app=createContainer({config:{appRoot:root,dbPath:path.join(root,'fixture.db'),webDistDir:path.resolve('dist/web/browser')},logger:new SilentLogger()});
const service=app.automationService;
service.configure({...structuredClone(DEFAULT_AUTOMATION_SETTINGS),repositoryPath:'/fixture',
  connections:[{id:'n',label:'Native',kind:'native',supportsImages:false}],
  agents:(['developer','tester','reviewer'] as const).map(role=>({id:role,role,runner:'codex',connectionId:'n',model:'fixture',instructions:''})),
  pipeline:['developer','tester','reviewer'],checks:[{command:'node',args:['--version']}]});
const task=app.taskService.createTask({title:'Recovery UI fixture'});
app.taskService.attachPlan({id:task.id,planContent:'# Approved plan',actor:'agent'});
service.enqueue(task.id);const run=service.claim('fixture')!;service.beginStage(run.id,run.leaseToken!);
const server=createApiServer(app);const browser=await chromium.launch({headless:true});
mkdirSync('.sat/screenshots',{recursive:true});const started=Date.now();
try {
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.tracing.start({screenshots:true,snapshots:true});
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await page.locator('sat-sidebar').getByText('Очередь задач',{exact:true}).click();
  await page.getByRole('button',{name:`Запуск ${task.id} ${run.id}`,exact:true}).click();
  await page.getByText('Изменить агентов запуска',{exact:true}).click();
  const editor=page.locator('sat-run-profile-editor');
  await editor.locator('p-select').nth(0).click();
  assert.equal(await page.getByRole('option',{name:'1. developer · fixture',exact:true}).count(),0);
  await page.getByRole('option',{name:'2. tester · fixture',exact:true}).click();
  await editor.locator('p-select').nth(1).click();
  await page.getByRole('option',{name:'codex · fixture · tester',exact:true}).click();
  await editor.getByRole('textbox',{name:'Модель нового агента',exact:true}).fill('new-fixture-model');
  const saved=page.waitForResponse(r=>r.url().endsWith(`/runs/${run.id}/profile`)&&r.request().method()==='POST');
  await editor.getByText('Применить к этапу',{exact:true}).click();assert.equal((await saved).status(),200);
  const updated=service.detail(run.id).run;
  assert.equal(updated.id,run.id);assert.equal(updated.status,'running');
  assert.equal(updated.settings.agents.find(a=>a.id===updated.settings.pipeline[1])?.model,'new-fixture-model');
  await page.screenshot({path:'.sat/screenshots/run-profile-editor.png',fullPage:true});
  service.fail(run.id,run.leaseToken!,'Requirements changed after routing; restart the run.');
  await page.getByText('Анализ сбоя',{exact:true}).click();
  const dialog=page.getByRole('dialog',{name:/Предлагаемое исправление|Анализ/});
  await page.getByText('Причина подтверждена',{exact:true}).waitFor();
  await page.getByText('План восстановления',{exact:true}).waitFor();
  await page.getByText('Обновить требования и продолжить',{exact:true}).waitFor();
  assert.equal(await page.locator('.fix-diff-section').count(),0);
  await page.screenshot({path:'.sat/screenshots/run-diagnosis.png',fullPage:true});
  assert.deepEqual(errors,[]);await context.tracing.stop({path:'.sat/run-recovery-trace.zip'});
  console.log(JSON.stringify({passed:true,durationMs:Date.now()-started,pageErrors:errors.length,modelCalls:0,runIdPreserved:true}));
} catch(error) {const page=browser.contexts()[0]?.pages()[0];if(page){console.log((await page.locator('body').innerText()).slice(-2500));await page.screenshot({path:'.sat/screenshots/run-recovery-failed.png',fullPage:true});}throw error;}
finally {await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));app.close();rmSync(root,{recursive:true,force:true,maxRetries:3});}
