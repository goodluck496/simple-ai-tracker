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
