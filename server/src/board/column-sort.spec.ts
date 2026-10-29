import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ColumnSorting, type ColumnSort } from '../../../shared/board/column-sort.js';

test('column date ordering is deterministic, handles invalid dates and preserves manual positions', () => {
  const tasks = [
    { id: 'a', seq: 1, position: 2, createdAt: '2026-01-01', updatedAt: '2026-03-03' },
    { id: 'b', seq: 2, position: 1, createdAt: '2026-02-02', updatedAt: '2026-01-01' },
    { id: 'c', seq: 3, position: 3, createdAt: 'invalid', updatedAt: 'invalid' },
  ];
  const before = JSON.stringify(tasks);
  for (const [mode, expected] of Object.entries({ manual: 'bac', 'created-desc': 'bac', 'created-asc': 'abc', 'updated-desc': 'abc', 'updated-asc': 'bac' })) {
    assert.equal([...tasks].sort((a, b) => ColumnSorting.compare(a, b, mode as ColumnSort)).map(task => task.id).join(''), expected);
  }
  assert.equal(JSON.stringify(tasks), before);
  assert.ok(ColumnSorting.compare(tasks[0], { ...tasks[0], id: 'z' }, 'created-asc') < 0);
  assert.equal(ColumnSorting.valid('created-desc'), true);
  assert.equal(ColumnSorting.valid('unexpected'), false);
});
