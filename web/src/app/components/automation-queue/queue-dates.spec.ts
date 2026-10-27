import assert from 'node:assert/strict';
import test from 'node:test';
import { formatQueueDate, sortRunHistory } from './queue-dates';
import { filterQueueItems } from './queue-search';

test('queue dates show complete localized time with an explicit timezone and unknown legacy values', () => {
  const instant = '2026-10-28T12:34:56.000Z';
  const utc = formatQueueDate(instant, 'en-US', 'UTC');
  const losAngeles = formatQueueDate(instant, 'en-US', 'America/Los_Angeles');
  assert.match(utc, /2026|12:34:56|UTC/);
  assert.match(losAngeles, /2026|05:34:56|PDT|PST/);
  assert.notEqual(utc, losAngeles);
  assert.equal(formatQueueDate(undefined), 'Неизвестно');
  assert.equal(formatQueueDate('legacy-invalid'), 'Неизвестно');
});

test('history sorts by latest start or finish, puts unknown legacy dates last, and breaks ties by id', () => {
  const runs = [
    { id: 'z', startedAt: '2026-10-28T10:00:00.000Z' },
    { id: 'b', finishedAt: '2026-10-28T11:00:00.000Z' },
    { id: 'a', startedAt: '2026-10-28T11:00:00.000Z' },
    { id: 'resumed', startedAt: '2026-10-28T08:00:00.000Z', attemptStartedAt: '2026-10-28T11:30:00.000Z' },
    { id: 'legacy-2' },
    { id: 'legacy-1', updatedAt: '2026-10-28T12:00:00.000Z' },
  ];
  const sorted = sortRunHistory(runs);
  assert.deepEqual(sorted.map(({ id }) => id), ['resumed', 'a', 'b', 'z', 'legacy-1', 'legacy-2']);
  assert.deepEqual(sortRunHistory([...runs].reverse()).map(({ id }) => id), sorted.map(({ id }) => id));
  const searchable = sorted.map((run) => ({ ...run, taskId: 'SAT-10', title: run.id === 'z' ? 'match me' : 'other run' }));
  assert.deepEqual(sortRunHistory(filterQueueItems(searchable, 'match me')).map(({ id }) => id), ['z']);
});
