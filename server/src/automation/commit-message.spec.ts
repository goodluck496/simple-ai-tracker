import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommitMessage } from '../../../shared/automation/commit-message.js';

test('commit subject requires actual task ID, Russian change and explicit purpose', () => {
  const valid = '[#SAT-14] - Исправлен Dockerfile для загрузки инструкций в контейнере';
  assert.equal(CommitMessage.validate(valid, 'SAT-14'), valid);
  assert.equal(CommitMessage.validate('[#MS-212] - Добавлена проверка WebGL, чтобы обнаруживать ошибки рендеринга', 'MS-212').startsWith('[#MS-212] - '), true);
  for (const subject of [undefined, 42, '', '[SAT-14] - Исправлены сообщения для истории изменений',
    '[#SAT-13] - Исправлены сообщения для истории изменений', '[#SAT-14] - developer stage',
    '[#SAT-14] - Исправлены сообщения коммитов', '[#SAT-14] - Исправлено для ',
    valid + '\nbody', valid + '\r', ' ' + valid, valid + ' ', valid + 'а'.repeat(240)]) {
    assert.throws(() => CommitMessage.validate(subject, 'SAT-14'), /Commit message rejected/);
  }
});
