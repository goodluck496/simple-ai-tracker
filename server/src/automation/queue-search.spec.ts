import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterQueueItems } from '../../../web/src/app/components/automation-queue/queue-search.js';

test('queue search handles case, whitespace, task/run IDs, empty and absent matches', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ taskId: `SAT-${i}`, id: `run-${i}`,
    title: i === 73 ? '  Special   Fixture Title ' : `Run ${i}` }));
  assert.equal(filterQueueItems(items, '  special   fixture title ').length, 1);
  assert.equal(filterQueueItems(items, 'sat-73')[0]?.id, 'run-73');
  assert.equal(filterQueueItems(items, ' RUN-73 ')[0]?.taskId, 'SAT-73');
  assert.equal(filterQueueItems(items, 'no match').length, 0);
  assert.equal(filterQueueItems(items, '').length, 120);
});
