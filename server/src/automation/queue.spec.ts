import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS, RunStatus, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../../../shared/automation/presets.js';
import { QueuePresentation, QueueLane, RunPhase, RunProgressText } from '../../../shared/automation/queue.js';
import { TrackerToolRegistry } from '../mcp/tools.js';
import { AGENT_TRACKER_READ_TOOLS } from '../../../shared/automation/tracker-access.js';

function settings(model = 'old-model'): AutomationSettings {
  return { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/project',
    connections: [{ id: 'native', kind: 'native', label: 'Codex', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map((role) => ({ id: role, role, runner: 'codex', model, instructions: '', connectionId: 'native' })),
    pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] };
}
test('queue exposes all active runs, phases, heartbeat, human progress and linked task status without settings or lease tokens', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    app.automationService.configure(settings());
    const task = app.taskService.createTask({ title: 'Observed task' });
    app.automationService.enqueue(task.id);
    const run = app.automationService.claim('fixture')!;
    for (let i = 0; i < 101; i++) app.automationService.enqueue(app.taskService.createTask({ title: `Queue ${i}` }).id);
    assert.equal(app.automationService.queue().items.length, 102);
    assert.equal(run.taskId, task.id);
    app.automationService.beginStage(run.id, run.leaseToken!);
    app.automationService.heartbeat(run.id, run.leaseToken!);
    app.automationService.progress(run.id, run.leaseToken!, JSON.stringify({ type: 'item.started', item: { command: 'npm test' } }), RunPhase.Checks);
    const item = app.automationService.queue().items.find((entry) => entry.id === run.id)!;
    assert.equal(item.taskStatus, 'planning'); assert.equal(item.phase, RunPhase.Checks);
    assert.equal(item.lastMessage, 'Команда: npm test'); assert.ok(item.heartbeatAt); assert.ok(item.progressAt);
    assert.equal('leaseToken' in item, false); assert.equal('settings' in item, false);
    assert.equal(QueuePresentation.lane(item), QueueLane.Running);
    assert.match(QueuePresentation.health(item, Date.now(), { online: true }), /на связи/);
    app.automationService.fail(run.id, run.leaseToken!, 'MCP tool call requires approval, but approval policy is never');
    const failed = app.automationService.queue().items.find((entry) => entry.id === run.id)!;
    assert.equal(QueuePresentation.lane(failed), QueueLane.Attention); assert.ok(failed.canRestart);
    assert.match(QueuePresentation.health(failed, Date.now(), { online: true }), /requires approval/);
  } finally { app.close(); }
});
test('restart uses saved settings in a new immutable attempt, keeps old journal and rejects duplicate or unanswered work', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const service = app.automationService; service.configure(settings());
    const task = app.taskService.createTask({ title: 'Restart' });
    const first = service.enqueue(task.id); const running = service.claim('fixture')!;
    assert.throws(() => service.restart(first.id), /Остановите/);
    service.beginStage(first.id, running.leaseToken!);
    service.fail(first.id, running.leaseToken!, 'invalid model');
    service.configure(settings('correct-model'));
    const second = service.restart(first.id);
    assert.notEqual(first.id, second.id); assert.equal(second.restartedFromId, first.id);
    assert.equal(second.settings.agents[0].model, 'correct-model'); assert.equal(second.stage, 0);
    assert.equal(service.detail(first.id).run.settings.agents[0].model, 'old-model');
    assert.ok(service.detail(first.id).events.some((event) => event.kind === 'restarted'));
    assert.throws(() => service.restart(first.id), /active run/);
    service.cancel(second.id);
    app.taskService.askQuestions({ id: task.id, questions: ['Need access?'], actor: 'agent' });
    assert.throws(() => service.restart(first.id), /вопросы/);
    assert.equal(service.queue().items.find((item) => item.id === first.id)?.canResume, false);
  } finally { app.close(); }
});
test('pure task read tools advertise read-only, mutating and claiming tools do not', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const definitions = new TrackerToolRegistry(app).definitions();
    for (const name of AGENT_TRACKER_READ_TOOLS) assert.equal(definitions.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
    for (const name of ['tracker_get_next_task', 'tracker_set_status', 'tracker_automation_claim']) assert.equal(definitions.find((tool) => tool.name === name)?.annotations?.readOnlyHint, false);
    assert.equal(RunProgressText.format('{"type":"item.completed","item":{"type":"agent_message","text":"Inspecting tests"}}'), 'Inspecting tests');
    assert.equal(RunProgressText.format('{"type":"turn.started"}'), '');
  } finally { app.close(); }
});
