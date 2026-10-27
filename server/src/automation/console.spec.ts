import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSOLE_LIMITS, RunConsoleDecoder } from '../../../shared/automation/console.js';
import type { RunEvent } from '../../../shared/automation/contracts.js';
import { AgentHandoff, HANDOFF_LIMITS } from '../../../shared/automation/handoff.js';
import { ProgressBuffer } from '../../../shared/automation/progress-buffer.js';
import { createContainer } from '../bootstrap/container.js';
import { createApiServer } from '../api/http-server.js';
import { SilentLogger } from '../core/logger.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES } from '../../../shared/automation/presets.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const event = (id: number, text: string, kind = 'progress'): RunEvent => ({ id, runId: 'fixture', at: '2026-10-27T00:00:00Z', kind, text });
test('console reconstructs split JSONL, commands, cumulative output and exit codes without transport JSON or duplicates', () => {
  const command = JSON.stringify({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test' } });
  const output = JSON.stringify({ type: 'item.updated', item: { id: 'c1', aggregated_output: '  первая\r\n' } });
  const end = JSON.stringify({ type: 'item.completed', item: { id: 'c1', command: 'npm test', aggregated_output: '  первая\r\nошибка 😀\n', exit_code: 1 } });
  const events = [event(1, 'developer: fixture', 'stage'), event(2, command.slice(0, 30)), event(3, command.slice(30) + '\n' + output + '\n'), event(4, end)];
  const view = RunConsoleDecoder.render([...events, events[3]]);
  assert.deepEqual(view.lines.slice(1).map((line) => line.text), ['Команда завершена: exit 1.', 'ошибка 😀']);
  assert.equal(view.lines.at(-1)?.level, 'error'); assert.equal(view.incomplete, false);
  assert.deepEqual(RunConsoleDecoder.render(events), view, 'polling replay is idempotent');
  const twoStages = RunConsoleDecoder.render([...events, event(5, 'tester: fixture', 'stage'), event(6, command)]);
  assert.equal(twoStages.lines.filter((line) => line.text === 'Команда завершена: exit 1.').length, 1, 'Started/read events do not duplicate progress');
});
test('console preserves ordinary partial lines, strips ANSI/OSC and exposes raw only outside readable text', () => {
  const events = [event(1, '\u001b[32mпри'), event(2, 'вет\u001b[0m\r\n\u001b]0;hidden\u0007warn: fixture\n')];
  assert.deepEqual(RunConsoleDecoder.render(events).lines.map((line) => line.text), ['привет', 'warn: fixture']);
  const pending = RunConsoleDecoder.render([event(1, '{"type":"item.')]);
  assert.equal(pending.incomplete, true); assert.equal(pending.lines.length, 0);
  const unknown = RunConsoleDecoder.render([event(1, '{"type":"custom","secret":"payload"}\n')]);
  assert.equal(unknown.lines[0].text, 'Служебное событие: custom');
  assert.doesNotMatch(JSON.stringify(unknown), /payload/);
  const oversized = RunConsoleDecoder.render([event(1, '{"type":"item.completed","payload":"' + 'x'.repeat(CONSOLE_LIMITS.pendingChars)),
    event(2, 'HIDDEN_TAIL"}\nhealthy after oversized record\n')]);
  assert.equal(oversized.incomplete, false);
  assert.match(oversized.lines.map((line) => line.text).join('\n'), /healthy after oversized record/);
  assert.doesNotMatch(oversized.lines.map((line) => line.text).join('\n'), /HIDDEN_TAIL/);
  const stream = [event(1, JSON.stringify({ type: 'item.updated', item: { id: 'stream', aggregated_output: 'при' } }) + '\n'),
    event(2, JSON.stringify({ type: 'item.completed', item: { id: 'stream', aggregated_output: 'привет\nnext\n', exit_code: 0 } }) + '\n')];
  assert.deepEqual(RunConsoleDecoder.render(stream).lines.map((line) => line.text), ['Команда завершена: exit 0.']);
});
test('console renders errors and concise outcomes, bounds its window and resets between runs', () => {
  const events = [event(1, JSON.stringify({ type: 'item.completed', item: { id: 'answer', text: JSON.stringify({ verdict: 'pass', summary: 'Готово', plan: 'DO NOT PRINT PLAN' }) } })),
    event(2, JSON.stringify({ type: 'turn.failed', error: { message: 'stack: fixture error' } })),
    event(3, Array.from({ length: CONSOLE_LIMITS.lines + 20 }, (_, i) => `line ${i}`).join('\n') + '\n')];
  const view = RunConsoleDecoder.render(events);
  assert.equal(view.lines.length, CONSOLE_LIMITS.lines); assert.ok(view.omitted > 0);
  assert.equal(RunConsoleDecoder.render(events.slice(0, 2)).lines.length, 1, 'Native answer bodies and plans are not console progress');
  assert.equal(RunConsoleDecoder.render(events.slice(0, 2)).lines[0].level, 'error');
  assert.deepEqual(RunConsoleDecoder.render([]).lines, []);
  const nested = JSON.stringify({ type: 'error', error: { message: 'The fixture model does not exist.' } });
  const failed = RunConsoleDecoder.render([event(1, 'developer/codex failed: ' + JSON.stringify({ type: 'thread.started' }) + '\n'
    + JSON.stringify({ type: 'turn.failed', error: { message: nested } }), 'failed')]);
  assert.match(failed.lines.map((line) => line.text).join('\n'), /fixture model does not exist/);
  assert.doesNotMatch(failed.lines.map((line) => line.text).join('\n'), /thread.started|turn.failed|"type"/);
});

test('handoff preserves the actual plan and requirements while excluding machine logs and bounding optional evidence', () => {
  const plan = { version: 2, content: '# Agreed plan\nExact acceptance criteria.' };
  const compact = JSON.parse(AgentHandoff.task({ id: 'fixture', description: 'Requirement', plan,
    comments: [{ author: 'AI Agent', kind: 'note', text: 'RAW_LOG'.repeat(10000) }, { author: 'User', text: 'Keep this clarification.' }] }));
  assert.deepEqual(compact.plan, plan); assert.equal(compact.comments.length, 1);
  assert.match(compact.comments[0].text, /clarification/); assert.doesNotMatch(JSON.stringify(compact), /RAW_LOG/);
  assert.throws(() => AgentHandoff.task({ plan: { content: 'x'.repeat(HANDOFF_LIMITS.taskChars + 1) } }), /not silently truncated/);
  assert.match(AgentHandoff.feedback('x'.repeat(10000) + 'relevant trace'), /relevant trace$/);
  assert.ok(AgentHandoff.diff('x'.repeat(100000)).length < 16500);
});

test('progress buffer preserves ordinary JSON fragments and makes backlog loss explicit at record boundaries', () => {
  const buffer = new ProgressBuffer(40);
  buffer.append('{"type":'); assert.equal(buffer.take(), '{"type":');
  buffer.append('"thread.started"}\n'); assert.equal(buffer.take(), '"thread.started"}\n');
  buffer.append('x'.repeat(100)); buffer.append('tail\nhealthy\n');
  const text = buffer.take(); assert.match(text, /Журнал ограничен/); assert.match(text, /healthy/); assert.doesNotMatch(text, /tail/);
});

test('raw log download streams more than the preview window without losing long JSON and respects workspace scope', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sat-log-'));
  const app = createContainer({ config: { appRoot: root, dbPath: path.join(root, 'data', 'tracker.db') }, logger: new SilentLogger() });
  const server = createApiServer(app);
  try {
    app.automationService.configure({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), repositoryPath: '/fixture',
      connections: [{ id: 'fixture', label: 'Fixture', kind: 'native', supportsImages: false }],
      agents: STANDARD_TEAM_ROLES.map((role) => ({ id: role, role, runner: 'codex', model: 'fixture', connectionId: 'fixture', instructions: '' })),
      pipeline: [...STANDARD_TEAM_ROLES], checks: [{ command: 'npm', args: ['test'] }] });
    const task = app.taskService.createTask({ title: 'Fixture log' }); app.automationService.enqueue(task.id);
    const run = app.automationService.claim('fixture')!;
    const long = JSON.stringify({ type: 'item.completed', item: { id: 'long', aggregated_output: 'я'.repeat(25000) + '\n', exit_code: 0 } }) + '\n';
    app.automationService.progress(run.id, run.leaseToken!, long);
    for (let i = 0; i < 210; i++) app.automationService.progress(run.id, run.leaseToken!, `line ${i}\n`);
    assert.equal(app.automationService.detail(run.id).events.length, 200);
    app.workspaceManager.create('other');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/automation/runs/${run.id}/log`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /ndjson/);
    const all = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as RunEvent);
    assert.ok(all.length > 210); assert.equal(new Set(all.map((entry) => entry.id)).size, all.length);
    assert.equal(all.filter((entry) => entry.kind === 'progress').map((entry) => entry.text).join(''), long + Array.from({ length: 210 }, (_, i) => `line ${i}\n`).join(''));
    assert.equal((await fetch(`${base}/api/automation/runs/${run.id}/log`, { headers: { 'X-Tracker-Workspace': 'other' } })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); app.close(); rmSync(root, { recursive: true, force: true }); }
});
