import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskRouting, type RoutingDecision } from '../../../shared/automation/task-routing.js';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings, type AgentRole } from '../../../shared/automation/contracts.js';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { AutomationSettingsValidator } from './settings.js';

function settings(): AutomationSettings {
  const roles: AgentRole[] = ['router','analyst','developer','tester','reviewer'];
  return {...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath:'/project',
    connections:[{id:'native',label:'Native',kind:'native',supportsImages:false}],
    agents:[...roles,'developer' as const].map((role,i) => ({id:i===5?'alternate':role,role,runner:'codex',connectionId:'native',model:i===5?'strong-model':'basic-model',instructions:''})),
    pipeline:roles,checks:[{command:'npm',args:['test']}],routingProfileIds:['alternate']};
}
function decision(): RoutingDecision { return {version:1,complexity:'normal',risk:'medium',uncertainty:'low',reason:'API and UI behavior',
  brief:{goal:'Persist the requested value',scope:'Only requested behavior',criteria:[{id:'AC-1',requirement:'Value survives reload',method:'integration'}]},
  assignments:[{stage:2,profileId:'alternate',reason:'Multiple components'}]}; }

test('router validates choices, preserves original settings and selects the effective profile', () => {
  const config=settings(); const before=structuredClone(config); const parsed=TaskRouting.parse(JSON.stringify(decision()),config,0);
  assert.equal(TaskRouting.profile(config,2,{decision:parsed,sourceDescription:'',createdAt:''}).model,'strong-model');
  assert.deepEqual(config,before);
  for(const assignment of [{stage:2,profileId:'reviewer',reason:'wrong role'}, {stage:0,profileId:'alternate',reason:'past stage'}, {stage:2,profileId:'unknown',reason:'unknown'}]) {
    assert.throws(()=>TaskRouting.parse(JSON.stringify({...decision(),assignments:[assignment]}),config,0),/unapproved/);
  }
  assert.throws(()=>TaskRouting.parse(JSON.stringify(decision()),{...config,routingProfileIds:[]},0),/unapproved/);
  const duplicate=decision(); duplicate.brief.criteria.push({...duplicate.brief.criteria[0]});
  assert.throws(()=>TaskRouting.parse(JSON.stringify(duplicate),config,0),/criteria/);
});
test('router settings reject skipped checks, missing reviewers and invalid allowlists', () => {
  const validator=new AutomationSettingsValidator(); const config=settings();
  assert.deepEqual(validator.validate(config).routingProfileIds,['alternate']);
  assert.throws(()=>validator.validate({...config,routingProfileIds:['missing']}),/профили/);
  assert.throws(()=>validator.validate({...config,pipeline:config.pipeline.filter(id=>id!=='reviewer')}),/ревьюер/);
  assert.throws(()=>validator.validate({...config,pipelineRoutes:[{from:'tester',passTo:null}]}),/пропуском/);
});
test('acceptance report cannot omit, duplicate or label automated criteria manual', () => {
  const brief=decision().brief;
  for(const results of [[],[{id:'AC-1',status:'manual',evidence:'not run'}],[{id:'AC-2',status:'passed',evidence:'green'}]])
    assert.throws(()=>TaskRouting.acceptance(JSON.stringify({results}),brief));
  assert.equal(TaskRouting.acceptance(JSON.stringify({results:[{id:'AC-1',status:'passed',evidence:'test persistence: value returned after reload'}]}),brief)[0].status,'passed');
});
test('router lifecycle persists decisions, actual usage model and acceptance metrics, rejects missing and stale reports', () => {
  const app=createContainer({config:{dbPath:':memory:'},logger:new SilentLogger()});
  try {
    const service=app.automationService; service.configure(settings());
    const task=app.taskService.createTask({title:'Routed task',description:'Persist a value'});service.enqueue(task.id);
    const run=service.claim('test-worker')!;const token=run.leaseToken!;const sha='a'.repeat(40);
    const finish=(plan='',commit=sha)=>service.completeStage(run.id,token,{verdict:'pass',summary:'Verified',plan},`sat/${run.id}`,commit);
    service.beginStage(run.id,token);finish(JSON.stringify(decision()));
    service.beginStage(run.id,token);finish('# Plan\n1. Persist value and add reload test.');
    service.beginStage(run.id,token);
    assert.equal(service.detail(run.id).run.usageAttempts?.at(-1)?.model,'strong-model');finish();
    service.beginStage(run.id,token);assert.throws(()=>finish(),/JSON|Unexpected/);
    assert.equal(service.detail(run.id).run.stage,3);
    finish(JSON.stringify({results:[{id:'AC-1',status:'passed',evidence:'persistence.test: value survives reload'}]}));
    service.beginStage(run.id,token);assert.throws(()=>finish('','b'.repeat(40)),/Current commit/);
    const completed=finish();assert.equal(completed.status,'review');
    assert.equal(completed.acceptance?.results.length,1);
    const events=service.detail(run.id).events;
    assert.ok(events.some(e=>e.kind==='routing'));assert.ok(events.some(e=>e.kind==='acceptance'));
    assert.equal(completed.settings.maxAgentCalls,settings().maxAgentCalls);
    assert.equal(app.taskService.getTaskCard(task.id).status,'review');
  } finally {app.close();}
});

test('changed requirements resume through router in the same checkout, including an obsolete Doctor repair request', async () => {
  for (const repair of [false, true]) {
    const app=createContainer({config:{dbPath:':memory:'},logger:new SilentLogger()});
    try {
      const service=app.automationService;service.configure(settings());
      const task=app.taskService.createTask({title:'Clarified while writing',description:'Original scope'});
      const queued=service.enqueue(task.id);const run=service.claim('fixture')!;const token=run.leaseToken!;
      const checkout={repositoryRoot:'/project',worktreePath:'/saved-worktree',baseSha:'b'.repeat(40),dependencyMode:'isolated'};
      service.checkout(run.id,token,checkout);
      const finish=(plan='')=>service.completeStage(run.id,token,{verdict:'pass',summary:'Stage complete',plan},`sat/${run.id}`,'a'.repeat(40));
      service.beginStage(run.id,token);finish(JSON.stringify(decision()));
      service.beginStage(run.id,token);finish('# Original plan');
      service.beginStage(run.id,token);
      app.taskService.updateTask({id:task.id,description:'Original scope plus evidence requirement',actor:'user'});
      assert.throws(()=>finish(),/Requirements changed after routing/);
      service.fail(run.id,token,'Requirements changed after routing; restart the run.');
      const before=service.detail(run.id).run;
      const fix=await service.diagnoseFix(run.id);
      assert.equal(fix.action,'retry_stage');assert.match(fix.title,/маршрутизацию/);
      const resumed=repair ? service.resume(run.id,undefined,undefined,true) : await service.applyFix(run.id);
      assert.equal(resumed.id,queued.id);assert.equal(resumed.stage,0);assert.equal(resumed.revision,before.revision+1);
      assert.equal(resumed.routing,undefined);assert.equal(resumed.acceptance,undefined);assert.equal(resumed.doctorRepair,undefined);
      assert.deepEqual(resumed.checkout,before.checkout);assert.equal(resumed.branch,before.branch);assert.equal(resumed.commitSha,before.commitSha);
      assert.deepEqual(resumed.usageAttempts,before.usageAttempts);assert.deepEqual(resumed.settings,before.settings);
      const current=service.claim('fixture')!;
      service.beginStage(run.id,current.leaseToken!);
      const rerouted=service.completeStage(run.id,current.leaseToken!,{verdict:'pass',summary:'Rerouted',plan:JSON.stringify(decision())},`sat/${run.id}`,'c'.repeat(40));
      assert.equal(rerouted.routing?.sourceDescription,'Original scope plus evidence requirement');
      assert.equal(rerouted.stage,1);
      service.beginStage(run.id,current.leaseToken!);
      service.completeStage(run.id,current.leaseToken!,{verdict:'pass',summary:'Replanned',plan:'# Updated plan including evidence'},`sat/${run.id}`,'c'.repeat(40));
      service.beginStage(run.id,current.leaseToken!);
      assert.equal(service.detail(run.id).run.stage,2);
    } finally { app.close(); }
  }
});

test('manual future profile choice during router execution wins over the router proposal',()=>{
  const app=createContainer({config:{dbPath:':memory:'},logger:new SilentLogger()});
  try {
    const service=app.automationService;service.configure(settings());
    const task=app.taskService.createTask({title:'Manual model choice',description:'Fixed requirements'});
    service.enqueue(task.id);const run=service.claim('fixture')!;const token=run.leaseToken!;
    service.beginStage(run.id,token);
    service.changeStageProfile(run.id,2,'alternate','human-selected-model');
    const result=service.completeStage(run.id,token,{verdict:'pass',summary:'Routed',plan:JSON.stringify(decision())},`sat/${run.id}`,'a'.repeat(40));
    assert.deepEqual(result.routing?.decision.assignments,[]);
    assert.equal(TaskRouting.profile(result.settings,2,result.routing).model,'human-selected-model');
  } finally {app.close();}
});
test('requirements changed while router is running cannot be published as a current decision',()=>{
  const app=createContainer({config:{dbPath:':memory:'},logger:new SilentLogger()});
  try {
    const service=app.automationService;service.configure(settings());
    const task=app.taskService.createTask({title:'Race with clarification',description:'Old scope'});
    service.enqueue(task.id);const run=service.claim('fixture')!;service.beginStage(run.id,run.leaseToken!);
    app.taskService.updateTask({id:task.id,description:'New scope',actor:'user'});
    assert.throws(()=>service.completeStage(run.id,run.leaseToken!,{verdict:'pass',summary:'Old proposal',plan:JSON.stringify(decision())},`sat/${run.id}`,'a'.repeat(40)),/Requirements changed/);
  } finally {app.close();}
});
