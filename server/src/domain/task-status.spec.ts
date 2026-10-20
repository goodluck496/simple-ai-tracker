import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALLOWED_TRANSITIONS, assertTransition, canTransition, isTaskStatus, STATUS_META, TASK_STATUSES, USER_ONLY_STATUSES } from './task-status.js';
import { TrackerError } from '../core/errors.js';

const status = (value: string): Parameters<typeof assertTransition>[0] => {
  if (!isTaskStatus(value)) throw new Error(`bad status ${value}`);
  return value;
};

describe('workflow статусов', () => {
  it('содержит ровно 8 стадий в порядке жизненного цикла', () => {
    assert.deepEqual([...TASK_STATUSES], [
      'backlog',
      'planning',
      'questions',
      'ready',
      'in_progress',
      'testing',
      'review',
      'done',
    ]);
  });

  it('описывает каждую стадию метаданными и подсказкой агенту', () => {
    for (const item of TASK_STATUSES) {
      const meta = STATUS_META[item];
      assert.equal(meta.status, item);
      assert.ok(meta.title.length > 0);
      assert.ok(meta.agentGuidance.length > 0);
    }
  });

  it('разрешает агенту переход по регламенту', () => {
    assert.doesNotThrow(() => assertTransition(status('backlog'), status('planning'), 'agent'));
    assert.doesNotThrow(() => assertTransition(status('planning'), status('questions'), 'agent'));
    assert.doesNotThrow(() => assertTransition(status('questions'), status('ready'), 'agent'));
    assert.doesNotThrow(() => assertTransition(status('ready'), status('in_progress'), 'agent'));
    assert.doesNotThrow(() => assertTransition(status('in_progress'), status('testing'), 'agent'));
    assert.doesNotThrow(() => assertTransition(status('testing'), status('review'), 'agent'));
  });

  it('запрещает агенту закрывать задачу в done', () => {
    assert.ok(USER_ONLY_STATUSES.includes('done'));
    assert.throws(
      () => assertTransition(status('review'), status('done'), 'agent'),
      (error: unknown) => error instanceof TrackerError && error.code === 'STATUS_REQUIRES_USER',
    );
  });

  it('разрешает пользователю перемещать карточку в любой статус', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        assert.doesNotThrow(() => assertTransition(from, to, 'user'));
      }
    }
  });

  it('отклоняет недопустимый переход агента', () => {
    assert.equal(canTransition('backlog', 'review'), false);
    assert.throws(
      () => assertTransition(status('backlog'), status('review'), 'agent'),
      (error: unknown) => error instanceof TrackerError && error.code === 'INVALID_TRANSITION',
    );
    assert.deepEqual(ALLOWED_TRANSITIONS.backlog.length > 0, true);
  });
});
