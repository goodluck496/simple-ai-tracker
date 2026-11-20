import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../shared/automation/contracts.js';
import { ProjectEnvironment } from './runners/project-environment.js';
import { ModelApiRunner } from './runners/model-api-runner.js';

test('a shared skill has project-specific roles and queued runs retain their assigned revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-skill-library-'));
  const config = { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db') };
  let app = createContainer({ config, logger: new SilentLogger() });
  try {
    const library = app.automationService.skillLibrary;
    const skill = library.save({ name: 'Fixture', description: 'When checking a fixture', content: 'Skill body version one.' });
    assert.ok(!JSON.stringify(library.list()).includes(skill.content));
    app.workspaceManager.create('second');
    let queued = '';
    app.workspaceManager.within('second', () => {
      const service = app.automationService;
      const cfg = { ...DEFAULT_AUTOMATION_SETTINGS, repositoryPath: root, checks: [{ command: 'node', args: ['--version'] }],
        pipeline: ['developer', 'reviewer'], connections: [{ id: 'n', label: 'n', kind: 'native' as const, supportsImages: false }],
        agents: (['developer', 'reviewer'] as const).map(role => ({ id: role, role, runner: 'codex' as const, model: 'fixture', instructions: '', connectionId: 'n' })) };
      assert.throws(() => service.configure({ ...cfg, skillBindings: [{skillId: 'unknown', roles: []}] }), /Неизвестный/);
      service.configure({...cfg, skillBindings: [{skillId: skill.id, roles: ['developer']}]});
      queued = service.enqueue(app.taskService.createTask({title:'Check skill version'}).id).id;
    });
    assert.equal(app.automationService.settings().skillBindings, undefined);
    const updated = library.save({ ...skill, content: 'Skill body version two.' }, skill.id);
    assert.equal(updated.version, 2);
    assert.throws(() => library.save(skill, skill.id), /уже изменён/);
    app.close();
    app = createContainer({ config, logger: new SilentLogger() });
    app.workspaceManager.within('second', () => {
      const service = app.automationService;
      const run = service.claim('worker')!;
      assert.equal(run.id, queued);
      assert.deepEqual(run.skillVersions, [{id: skill.id, version: 1}]);
      assert.ok(!JSON.stringify(run).includes(skill.content));
      assert.throws(() => service.stageSkills(run.id, 'wrong-token'));
      assert.deepEqual(service.stageSkills(run.id, run.leaseToken!), [skill]);
      service.beginStage(run.id, run.leaseToken!);
      service.completeStage(run.id, run.leaseToken!, {verdict:'pass',summary:'checked'}, 'sat/test', 'a'.repeat(40));
      assert.deepEqual(service.stageSkills(run.id, run.leaseToken!), []);
      const next = service.enqueue(app.taskService.createTask({title:'New version'}).id);
      assert.deepEqual(next.skillVersions, [{id: skill.id, version: 2}]);
    });
  } finally { app.close(); await fs.rm(root, {recursive:true, force:true}); }
});

test('API and native roles receive a short catalog with skill text available on demand', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-skill-worker-'));
  try {
    const skill = {id:'fixture', version:3, name:'Fixture', description:'When X happens', content:'UNIQUE_FULL_SKILL'};
    const job: AgentJob = { cwd, runId:'fixture', prompt:'Do the task.', signal:AbortSignal.timeout(10000),
      profile:{ id:'dev',role:'developer',runner:'model-api',model:'fixture',connectionId:'n',instructions:'' },
      connection:{id:'n',kind:'openai-compatible',baseUrl:'http://fixture',label:'fixture',supportsImages:false},
      settings:DEFAULT_AUTOMATION_SETTINGS, librarySkills:[skill] };
    const env = new ProjectEnvironment();
    const api = await env.prepare(job, () => {});
    assert.match(api.prompt, /When X happens/); assert.ok(!api.prompt.includes(skill.content));
    const native = await env.prepare({...job,profile:{...job.profile,runner:'codex'}}, () => {});
    assert.match(native.prompt, /\.sat\/skills\/developer\/fixture-v3.md/);
    assert.ok(!native.prompt.includes(skill.content));
    assert.equal(await fs.readFile(path.join(cwd,'.sat/skills/developer/fixture-v3.md'),'utf8'), skill.content);
    let turn = 0;
    await new ModelApiRunner(undefined, async (_url, options) => {
      const body = String(options?.body);
      const call = (name: string, args: object) => Response.json({choices:[{message:{tool_calls:[{id:'call',function:{name,arguments:JSON.stringify(args)}}]}}]});
      if (turn++ === 0) { assert.ok(!body.includes(skill.content)); return call('read_skill',{id:'unassigned'}); }
      if (turn === 2) { assert.match(body,/not assigned/); return call('read_skill',{id:'fixture'}); }
      assert.ok(body.includes(skill.content));
      return call('finish_task',{verdict:'pass',summary:'ok'});
    }).run(api, () => {});
    const legacy = await env.prepare({...job,librarySkills:undefined}, () => {});
    assert.equal(legacy.prompt, job.prompt);
  } finally { await fs.rm(cwd, { recursive:true, force:true }); }
});
