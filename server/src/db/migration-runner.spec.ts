import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeSqliteDatabase } from './node-sqlite-database.js';
import { MigrationRunner } from './migration-runner.js';

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
