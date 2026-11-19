import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createContainer} from '../bootstrap/container.js';
import {SilentLogger} from '../core/logger.js';
import {DEFAULT_AUTOMATION_SETTINGS} from '../../../shared/automation/contracts.js';

test('future agents change during execution without restarting or overriding completed work and usage',()=>{
  const app=createContainer({config:{dbPath:':memory:'},logger:new SilentLogger()});
  try {
    const service=app.automationService;
    const settings=service.configure({...structuredClone(DEFAULT_AUTOMATION_SETTINGS),repositoryPath:'/fixture',
      connections:[{id:'n',label:'Native',kind:'native',supportsImages:false}],
      agents:(['developer','tester','reviewer'] as const).map(role=>({id:role,role,runner:'codex',connectionId:'n',model:'original',instructions:'Configured instructions'})),
      pipeline:['developer','tester','reviewer'],checks:[{command:'node',args:['--version']}],
      pipelineRoutes:[{from:'tester',passTo:'reviewer',retry:{to:'developer',limit:1,exhausted:'stop'}},{from:'reviewer',passTo:null}]});
    const task=app.taskService.createTask({title:'Change profiles without losing progress'});
    app.taskService.attachPlan({id:task.id,planContent:'# Approved plan',actor:'agent'});
    service.enqueue(task.id);const run=service.claim('worker')!;const token=run.leaseToken!;
    service.checkout(run.id,token,{repositoryRoot:'/fixture',worktreePath:'/saved-worktree',baseSha:'b'.repeat(40),dependencyMode:'isolated'});
    service.beginStage(run.id,token);const before=service.detail(run.id).run;
    assert.throws(()=>service.changeStageProfile(run.id,0,'developer','other'),/Сначала остановите/);
    assert.throws(()=>service.changeStageProfile(run.id,1,'developer','other'),/той же роли/);
    const changed=service.changeStageProfile(run.id,1,'tester','new-test-model','tester');
    assert.equal(changed.id,run.id);assert.equal(changed.status,'running');assert.equal(changed.stage,0);
    assert.equal(changed.leaseToken,before.leaseToken);service.heartbeat(run.id,token);assert.deepEqual(changed.checkout,before.checkout);
    assert.deepEqual(changed.usageAttempts,before.usageAttempts);assert.equal(changed.revision,before.revision);
    assert.deepEqual(service.settings(),JSON.parse(JSON.stringify(settings)));
    assert.throws(()=>service.changeStageProfile(run.id,1,'tester','different','tester'),/уже изменился/);
    const completed=service.completeStage(run.id,token,{verdict:'pass',summary:'Developer completed'},`sat/${run.id}`,'a'.repeat(40));
    const nextId=completed.settings.pipeline[1];
    assert.equal(completed.settings.agents.find(a=>a.id===nextId)?.model,'new-test-model');
    assert.equal(completed.settings.pipelineRoutes?.[0].from,nextId);
    service.beginStage(run.id,token);
    assert.equal(service.detail(run.id).run.usageAttempts?.at(-1)?.model,'new-test-model');
    assert.throws(()=>service.changeStageProfile(run.id,0,'developer','other'),/текущий или будущий/);
    assert.throws(()=>service.changeStageProfile(run.id,1,'tester','other'),/Сначала остановите/);
    service.fail(run.id,token,'Fixture stopped');const stopped=service.detail(run.id).run;
    const replaced=service.changeStageProfile(run.id,1,'tester','replacement-model');
    assert.equal(replaced.status,'failed');assert.equal(replaced.revision,stopped.revision+1);
    assert.deepEqual(replaced.checkout,stopped.checkout);assert.equal(replaced.commitSha,stopped.commitSha);
    assert.deepEqual(replaced.usageAttempts,stopped.usageAttempts);
    assert.equal(service.resume(run.id).id,run.id);
  } finally {app.close();}
});
