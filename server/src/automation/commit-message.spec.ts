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

test('worker supplies the accepted task purpose while preserving the actual Russian change', () => {
  const subject = '[#SAT-14] - Изменены параметры горения костра';
  const completed = CommitMessage.forTask(subject, 'SAT-14', 'Параметризация костра');
  assert.equal(completed, subject + ', чтобы выполнить требование задачи «Параметризация костра»');
  assert.equal(CommitMessage.validate(completed, 'SAT-14'), completed);
  assert.equal(CommitMessage.forTask(completed, 'SAT-14', 'Same task'), completed);
  assert.throws(() => CommitMessage.forTask('[#OTHER] - developer stage', 'SAT-14', 'Параметризация костра'));
  assert.throws(() => CommitMessage.forTask('[#SAT-14] - developer stage', 'SAT-14', 'Параметризация костра'));
  assert.throws(() => CommitMessage.forTask(subject + '\nbody', 'SAT-14', 'Параметризация костра'));
});
