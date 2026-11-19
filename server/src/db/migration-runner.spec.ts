import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeSqliteDatabase } from './node-sqlite-database.js';
import { MigrationRunner } from './migration-runner.js';
import { MIGRATIONS } from './migrations/index.js';

test('a waiting migration rechecks the version after acquiring the write lock', () => {
  class ConcurrentMigrationDatabase extends NodeSqliteDatabase {
    private competing = true;
    public override transaction<T>(fn: () => T): T {
      if (this.competing) {
        this.competing = false;
        super.transaction(() => {
          this.exec('CREATE TABLE fixture (id INTEGER)');
          this.setSchemaVersion(1);
        });
      }
      return super.transaction(fn);
    }
  }
  const db = new ConcurrentMigrationDatabase({ file: ':memory:' });
  try {
    const result = new MigrationRunner(db, undefined, [{ version: 1, name: 'fixture', sql: 'CREATE TABLE fixture (id INTEGER)' }]).run();
    assert.deepEqual(result, { from: 0, to: 1, applied: [] });
    assert.equal(db.prepare('SELECT count(*) AS n FROM fixture').get<{n:number}>()?.n, 0);
  } finally { db.close(); }
});

test('migration 005 upgrades an existing v4 database with improvement tables and indexes', () => {
  const db = new NodeSqliteDatabase({ file: ':memory:' });
  try {
    const pre = new MigrationRunner(db, undefined, MIGRATIONS.filter(m => m.version < 5)).run();
    assert.equal(pre.to, 4);
    db.prepare(`INSERT INTO tasks(id, seq, type, title, description, status, created_at, updated_at) VALUES (?, 1, 'task', 'Legacy', '', 'review', ?, ?)`)
      .run(['SAT-1', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']);
    db.prepare(`INSERT INTO agent_runs(id, task_id, status, payload, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(['legacy-run', 'SAT-1', 'review', JSON.stringify({ id: 'legacy-run', startedAt: '2026-11-01T00:00:00.000Z' }), '2026-11-01T00:00:00.000Z']);
    const upgraded = new MigrationRunner(db, undefined, MIGRATIONS).run();
    assert.equal(upgraded.from, 4);
    assert.equal(upgraded.to, 5);
    assert.deepEqual(upgraded.applied, ['005-automation_improvements']);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%' ORDER BY name`)
      .all<{ name: string }>().map(r => r.name);
    assert.deepEqual(tables, ['automation_check_executions', 'automation_check_intents', 'automation_improvement_cases', 'automation_occurrences']);
    const index = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runs_started'`).get<{ name: string }>();
    assert.equal(index?.name, 'idx_agent_runs_started');
    assert.equal(db.prepare('SELECT id FROM agent_runs WHERE id = ?').get<{ id: string }>(['legacy-run'])?.id, 'legacy-run');
  } finally { db.close(); }
});
