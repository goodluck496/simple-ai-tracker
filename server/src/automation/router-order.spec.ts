import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings, type AgentRole} from '../../../shared/automation/contracts.js';
import {PipelinePolicy} from '../../../shared/automation/pipeline-policy.js';

function fixture(): AutomationSettings {
  const roles: AgentRole[] = ['router','developer','tester','reviewer'];
  return {...structuredClone(DEFAULT_AUTOMATION_SETTINGS),repositoryPath:'/fixture',
    agents:roles.map(role=>({id:role,role,runner:'codex',connectionId:'n',model:'fixture',instructions:''})),
    pipeline:['developer','tester','reviewer'],checks:[{command:'npm',args:['test']}],
    pipelineRoutes:[{from:'tester',passTo:'reviewer',retry:{to:'developer',limit:2,exhausted:'stop'}},
      {from:'reviewer',passTo:null,retry:{to:'developer',limit:1,exhausted:'ask'}}]};
}
test('new or re-enabled router is inserted first without changing terminal and retry edges',()=>{
  const settings=fixture();const original=structuredClone(settings);
  const next=PipelinePolicy.includeStage(settings,'router');
  assert.deepEqual(next.pipeline,['router','developer','tester','reviewer']);
  assert.deepEqual(next.pipelineRoutes,settings.pipelineRoutes);
  assert.equal(PipelinePolicy.routerProblem(next),undefined);
  assert.equal(PipelinePolicy.routeProblem(next),undefined);
  assert.deepEqual(settings,original);
  assert.equal(PipelinePolicy.includeStage(next,'router'),next);
});
test('moving a legacy trailing router first removes its obsolete incoming terminal edge and retains retries',()=>{
  const settings=fixture();settings.pipeline.push('router');settings.pipelineRoutes![1].passTo='router';
  const next=PipelinePolicy.reorder(settings,3,0);
  assert.deepEqual(next.pipeline,['router','developer','tester','reviewer']);
  assert.equal(next.pipelineRoutes![1].passTo,undefined);
  assert.deepEqual(next.pipelineRoutes![1].retry,settings.pipelineRoutes![1].retry);
  assert.equal(next.pipelineRoutes![0].passTo,'reviewer');
  assert.equal(PipelinePolicy.routeProblem(next),undefined);
  assert.equal(PipelinePolicy.routerProblem(next),undefined);
  assert.equal(settings.pipelineRoutes![1].passTo,'router');
});
test('router still forbids skipped checks and cannot move away from first place',()=>{
  const next=PipelinePolicy.includeStage(fixture(),'router');
  assert.throws(()=>PipelinePolicy.reorder(next,0,3));
  assert.match(PipelinePolicy.routerProblem({...next,pipelineRoutes:[{from:'tester',passTo:null}]})!,/пропуском/);
  assert.throws(()=>PipelinePolicy.reorder(next,1,3));
});
test('ordinary appended stages retain terminal reconnection behavior',()=>{
  const settings=fixture();settings.agents.push({...settings.agents[3],id:'another-reviewer'});
  const next=PipelinePolicy.includeStage(settings,'another-reviewer');
  assert.equal(next.pipeline.at(-1),'another-reviewer');assert.equal(next.pipelineRoutes![1].passTo,'another-reviewer');
  assert.equal(PipelinePolicy.routeProblem(next),undefined);
});
