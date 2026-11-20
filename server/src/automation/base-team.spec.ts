import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { applyTeam } from '../../../shared/automation/base-team.js';

test('shared team inheritance, field overrides, resets and legacy settings survive across projects and restarts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-base-team-'));
  const config = {appRoot:root, dbPath:path.join(root,'data','tracker.db')};
  let app = createContainer({config,logger:new SilentLogger()});
  const team: AutomationSettings = {...DEFAULT_AUTOMATION_SETTINGS, repositoryPath:'/source', baseBranch:'source-branch',
    checks:[{command:'npm',args:['test']}], maxAgentCalls:7,
    connections:[{id:'native',label:'Native',kind:'native',supportsImages:false}],
    agents:[{id:'dev',role:'developer',runner:'codex',model:'first',connectionId:'native',instructions:'Shared text'}],
    pipeline:['dev'], skillBindings:[{skillId:'regression-tests',roles:['developer']}],
    mcpServers:[{name:'docs',url:'https://example.org/mcp',roles:['developer'],tools:['lookup']}]};
  try {
    app.workspaceManager.create('linked');
    app.workspaceManager.create('legacy');
    app.workspaceManager.within('legacy', () => app.automationService.configure({...team, repositoryPath:'/legacy'}));
    const published = app.automationService.publishTeam(team, 0);
    assert.equal(published.revision, 1);
    assert.ok(!JSON.stringify(published).includes('/source'));
    assert.throws(() => app.automationService.publishTeam(team, 0), /изменилась/);
    let runId = '';
    app.workspaceManager.within('linked', () => {
      const service = app.automationService;
      const {base,settings} = service.projectTeam.read();
      assert.equal(base.mode, 'inherited');
      assert.equal(settings.baseBranch, 'main');
      assert.equal(settings.maxAgentCalls, DEFAULT_AUTOMATION_SETTINGS.maxAgentCalls);
      assert.deepEqual(settings.checks, []);
      assert.deepEqual(settings.mcpServers, team.mcpServers);
      assert.deepEqual(settings.skillBindings, team.skillBindings);
      settings.agents[0].instructions = 'Local text';
      settings.repositoryPath = '/linked';
      settings.checks = team.checks;
      service.configure(settings, 1);
      runId = service.enqueue(app.taskService.createTask({title:'Frozen team'}).id).id;
    });
    const next = structuredClone(team);
    next.agents[0].model = 'second';
    next.agents[0].instructions = 'New shared text';
    next.skillBindings!.push({skillId:'browser-acceptance',roles:['visual-validator']});
    next.mcpServers![0].tools.push('list');
    app.automationService.publishTeam(next, 1);
    app.close();
    app = createContainer({config,logger:new SilentLogger()});
    app.workspaceManager.within('legacy', () => {
      const {settings,base} = app.automationService.projectTeam.read();
      assert.equal(base.mode, 'independent');
      assert.equal(settings.agents[0].model,'first');
      app.automationService.configure(applyTeam(settings,base.team!),base.revision,true);
      assert.equal(app.automationService.projectTeam.read().base.mode,'inherited');
      assert.equal(app.automationService.settings().repositoryPath,'/legacy');
    });
    app.workspaceManager.within('linked', () => {
      const service = app.automationService;
      const {base,settings} = service.projectTeam.read();
      assert.equal(base.mode,'custom');
      assert.equal(settings.agents[0].instructions,'Local text');
      assert.equal(settings.agents[0].model,'second');
      assert.deepEqual(settings.mcpServers,next.mcpServers);
      assert.deepEqual(settings.skillBindings,next.skillBindings);
      assert.throws(() => service.configure(settings,1), /изменилась/);
      const run = service.list().find(run => run.id === runId)!;
      assert.equal(run.settings.agents[0].model,'first');
      assert.deepEqual(run.settings.mcpServers,team.mcpServers);
      service.configure(applyTeam(settings, base.team!), 2, true);
      assert.equal(service.projectTeam.read().base.mode,'inherited');
      assert.equal(service.settings().agents[0].instructions,'New shared text');
      assert.equal(service.settings().repositoryPath,'/linked');
      assert.deepEqual(service.settings().checks, team.checks);
      // A local profile depends on a model connection later removed upstream.
      const local = service.settings();
      local.agents.push({...local.agents[0],id:'custom'});
      service.configure(local,2);
    });
    next.connections[0].id = 'replacement';
    next.agents[0].connectionId = 'replacement';
    app.automationService.publishTeam(next,2);
    app.workspaceManager.within('linked', () => {
      const {base, settings} = app.automationService.projectTeam.read();
      assert.equal(base.mode,'conflict');
      assert.equal(settings.connections[0].id,'native');
      app.automationService.configure(applyTeam(settings, base.team!),3,true);
      assert.equal(app.automationService.projectTeam.read().base.mode,'inherited');
    });
  } finally {
    app.close();
    await rm(root, {recursive:true,force:true});
  }
});
