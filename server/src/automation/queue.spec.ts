import test from 'node:test';
import assert from 'node:assert/strict';
import { createContainer } from '../bootstrap/container.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS, RunStatus, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../../../shared/automation/presets.js';
import { QueuePresentation, QueueLane, RunPhase, RunProgressText } from '../../../shared/automation/queue.js';
import { TrackerToolRegistry } from '../mcp/tools.js';
import { AGENT_TRACKER_READ_TOOLS } from '../../../shared/automation/tracker-access.js';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function settings(model = 'old-model'): AutomationSettings {
  return { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/project',
    connections: [{ id: 'native', kind: 'native', label: 'Codex', supportsImages: false }],
    agents: STANDARD_TEAM_ROLES.map((role) => ({ id: role, role, runner: 'codex', model, instructions: '', connectionId: 'native' })),
    pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] };
}

test('dequeue is scoped to a workspace and serializes with claim across database connections', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-dequeue-'));
  const config = { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db') };
  const first = createContainer({ config, logger: new SilentLogger() });
  let second: ReturnType<typeof createContainer> | undefined;
  try {
    first.automationService.configure(settings());
    const task = first.taskService.createTask({ title: 'First workspace' });
    const queued = first.automationService.enqueue(task.id);
    first.workspaceManager.create('other');
    first.workspaceManager.within('other', () => {
      first.automationService.configure(settings());
      const otherTask = first.taskService.createTask({ title: 'Other workspace' });
      assert.equal(otherTask.id, task.id);
      const other = first.automationService.enqueue(otherTask.id);
      assert.throws(() => first.automationService.dequeue(queued.id), /not found|не найден/i);
      first.automationService.dequeue(other.id);
      assert.equal(first.automationService.claim('other-worker'), null);
      assert.equal(first.taskService.getTaskCard(otherTask.id).title, 'Other workspace');
    });
    second = createContainer({ config, logger: new SilentLogger() });
    first.automationService.dequeue(queued.id);
    assert.equal(second.automationService.claim('worker-b'), null, 'cancel wins before claim');
    const again = first.automationService.enqueue(task.id);
    const owned = second.automationService.claim('worker-b')!;
    assert.equal(owned.id, again.id);
    assert.throws(() => first.automationService.dequeue(again.id), /покинул очередь/, 'claim wins before cancel');
    assert.equal(first.automationService.detail(again.id).run.status, 'running');
    assert.equal(first.automationService.detail(queued.id).run.status, 'cancelled');
  } finally { second?.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});
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
    app.automationService.progress(run.id, run.leaseToken!, JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'PRIVATE_SOURCE_SENTINEL' } }), RunPhase.Checks);
    const item = app.automationService.queue().items.find((entry) => entry.id === run.id)!;
    assert.equal(item.taskStatus, 'planning'); assert.equal(item.phase, RunPhase.Checks);
    assert.equal(item.lastMessage, 'Команда завершена: exit 0.'); assert.ok(item.heartbeatAt); assert.ok(item.progressAt);
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
    assert.equal(RunProgressText.format('{"type":"item.completed","item":{"type":"agent_message","text":"Inspecting tests"}}'), '');
    assert.equal(RunProgressText.format('{"type":"turn.started"}'), '');
  } finally { app.close(); }
});
