import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StageJournal, type CheckpointUpdate } from './stage-journal.js';

test('journal flushes before failure, serializes session/note, ignores stale mail and never publishes source', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-journal-'));
  const updates: CheckpointUpdate[] = []; const logs: string[] = [];
  const key = 'a'.repeat(64);
  const journal = new StageJournal(cwd, key, async value => { updates.push(value); }, text => logs.push(text), () => assert.fail('Unexpected MCP failure'));
  try {
    await journal.start(); journal.session('conversation-1'); journal.session('conversation-1');
    const file = path.join(cwd, '.sat/stage-note.json');
    await fs.writeFile(file, JSON.stringify({ key: 'b'.repeat(64), note: { summary: 'old context', nextStep: 'old action' } }));
    await journal.flush();
    await fs.writeFile(file, JSON.stringify({ key, note: { summary: '```PRIVATE_SOURCE```', nextStep: 'action' } }));
    await journal.flush(); await journal.flush();
    await fs.writeFile(file, JSON.stringify({ key, note: { summary: 'Confirmed path', nextStep: 'Check current position interpolation' } }));
    await journal.close();
    assert.equal(updates.length, 2);
    assert.equal(updates[0].conversationId, 'conversation-1');
    assert.equal(updates[1].note?.summary, 'Confirmed path');
    assert.doesNotMatch(JSON.stringify(updates) + logs.join(''), /PRIVATE_SOURCE|old context/);
  } finally { await journal.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});

test('MCP publication failure aborts the stage and is surfaced on close', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-journal-error-'));
  let stopped = false;
  const journal = new StageJournal(cwd, 'a'.repeat(64), async () => { throw new Error('lease lost'); }, () => {}, () => { stopped = true; });
  try {
    await journal.start(); journal.session('conversation-1');
    await assert.rejects(journal.close(), /lease lost/); assert.equal(stopped, true);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('a new worker recovers unpublished mail from a hard crash before starting its model', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-journal-recover-'));
  const updates: CheckpointUpdate[] = []; const key = 'a'.repeat(64);
  const note = { summary: 'Result saved immediately before process exit', nextStep: 'Continue the focused check' };
  await fs.mkdir(path.join(cwd, '.sat'));
  await fs.writeFile(path.join(cwd, '.sat/stage-note.json'), JSON.stringify({ key, note }));
  const journal = new StageJournal(cwd, key, async value => { updates.push(value); }, () => {}, () => assert.fail());
  try {
    await journal.start();
    assert.deepEqual(updates, [{ key, note }]);
    const context = JSON.parse(await fs.readFile(path.join(cwd, '.sat/stage-context.json'), 'utf8'));
    assert.deepEqual(context.currentNote, note);
    await journal.close(); assert.equal(updates.length, 1);
  } finally { await journal.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});
