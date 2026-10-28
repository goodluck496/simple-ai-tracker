import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunActivity } from '../../../shared/automation/queue-activity.js';
import type { QueueItem } from '../../../shared/automation/queue.js';
import { AUTOMATION_TIMING } from '../../../shared/automation/contracts.js';

test('activity separates heartbeat, command progress, lost connection and measured stage completion', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const item = { status: 'running', phase: 'setup', stage: 1, pipeline: [{}, {}, {}, {}],
    heartbeatAt: new Date(now - 1000).toISOString(), phaseStartedAt: new Date(now - 180000).toISOString() } as QueueItem;
  let activity = RunActivity.evaluate(item, now, true);
  assert.equal(activity.state, 'quiet'); assert.equal(activity.animated, true);
  assert.equal(activity.percent, 25); assert.equal(activity.completed, 1); assert.equal(activity.phaseAge, 180000);
  activity = RunActivity.evaluate({ ...item, progressAt: new Date(now - 3000).toISOString() }, now, true);
  assert.equal(activity.state, 'active'); assert.equal(activity.eventAge, 3000);
  assert.equal(RunActivity.evaluate(item, now, false).state, 'disconnected');
  assert.equal(RunActivity.evaluate(item, now, false).animated, false);
  assert.equal(RunActivity.evaluate(item, now + AUTOMATION_TIMING.leaseMs + 1, true).state, 'stale');
  assert.equal(RunActivity.evaluate({ ...item, heartbeatAt: 'bad' }, now, true).animated, false);
  for (const status of ['failed', 'review', 'cancelled', 'queued', 'interrupted'] as const)
    assert.equal(RunActivity.evaluate({ ...item, status }, now, true).animated, false);
  assert.equal(RunActivity.evaluate({ ...item, stage: 10 }, now, true).percent, 100);
  assert.equal(RunActivity.evaluate({ ...item, pipeline: [] }, now, true).percent, null);
  assert.equal(RunActivity.elapsed(61000), '1 мин 1 с');
  assert.equal(RunActivity.elapsed(undefined), 'нет данных');
});
