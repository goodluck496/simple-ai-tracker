import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { createContainer, type AppContainer } from '../bootstrap/container.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';
import type { Clock } from './task-service.js';

/** Часы с шагом в секунду, чтобы имена бэкапов не совпадали. */
class StepClock implements Clock {
  private tick = 0;
  public constructor(private readonly start = '2026-05-01T10:00:00.000Z') {}
  public now(): string {
    const base = new Date(this.start).getTime() + this.tick * 1000;
    this.tick += 1;
    return new Date(base).toISOString();
  }
}

interface Fixture {
  readonly app: AppContainer;
  readonly dbPath: string;
  readonly backupDir: string;
  readonly workDir: string;
}

function createFixture(): Fixture {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-backup-'));
  const dbPath = path.join(workDir, 'data', 'tracker.db');
  const backupDir = path.join(workDir, 'data', 'backups');

  const app = createContainer({
    config: { dbPath, backupDir, idPrefix: 'SAT' },
    db: new NodeSqliteDatabase({ file: dbPath }),
    clock: new StepClock(),
    logger: new SilentLogger(),
  });

  return { app, dbPath, backupDir, workDir };
}

/** Читает задачи из файла бэкапа напрямую — так проверяется содержимое снимка. */
function readBackupTasks(filePath: string): string[] {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return db.prepare('SELECT id FROM tasks ORDER BY seq').all().map((row) => String(row.id));
  } finally {
    db.close();
  }
}

describe('BackupService', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.app.close();
    fs.rmSync(fixture.workDir, { recursive: true, force: true });
  });

  it('создаёт целостный снимок живой базы и отдаёт его в списке', () => {
    const { taskService, backupService } = fixture.app;
    taskService.createTask({ title: 'Первая' });
    taskService.createTask({ title: 'Вторая', type: 'bug' });

    const backup = backupService.create('test');
    assert.match(backup.name, /^tracker-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
    assert.ok(backup.size > 0);
    assert.ok(fs.existsSync(backup.path));
    assert.deepEqual(readBackupTasks(backup.path), ['SAT-1', 'SAT-2']);

    // Работа продолжается после снятия копии: снимок не блокирует базу.
    taskService.createTask({ title: 'Третья' });
    assert.deepEqual(readBackupTasks(backup.path), ['SAT-1', 'SAT-2'], 'снимок не «дописывается»');
    assert.equal(fixture.app.taskService.getStats().total, 3);

    const list = backupService.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, backup.name);
    assert.equal(backupService.find(backup.name)?.size, backup.size);
  });

  it('ротация удаляет старые копии и уважает лимит', () => {
    const { backupService } = fixture.app;
    for (let index = 0; index < 5; index += 1) backupService.create(`test-${index}`);

    assert.equal(backupService.list().length, 5);
    const removed = backupService.prune(2);
    assert.equal(removed, 3);

    const remaining = backupService.list();
    assert.equal(remaining.length, 2);
    assert.equal(backupService.prune(2), 0, 'повторная ротация ничего не удаляет');
    assert.equal(backupService.prune(0), 0, 'некорректный лимит игнорируется');
  });

  it('удаляет бэкап по имени и защищается от обхода каталога', () => {
    const { backupService } = fixture.app;
    const backup = backupService.create('test');

    assert.equal(backupService.remove('../tracker.db'), false);
    assert.equal(backupService.find('../../etc/passwd'), null);
    assert.throws(() => backupService.require('../evil.db'), /Недопустимое имя бэкапа/);

    assert.equal(backupService.remove(backup.name), true);
    assert.equal(backupService.list().length, 0);
    assert.equal(backupService.remove(backup.name), false);
  });

  it('восстанавливает базу из бэкапа, оставляя pre-restore копию', () => {
    const { taskService, backupService } = fixture.app;
    taskService.createTask({ title: 'До бэкапа' });
    const backup = backupService.create('pre-change');

    taskService.createTask({ title: 'После бэкапа' });
    assert.equal(fixture.app.taskService.getStats().total, 2);

    const result = backupService.restore(backup.name, { connection: fixture.app.db });
    assert.equal(result.restoredFrom, backup.name);
    assert.match(result.preRestoreBackup, /^tracker-/);

    // Переоткрываем базу и проверяем состояние «как в бэкапе».
    const reopened = new NodeSqliteDatabase({ file: fixture.dbPath });
    try {
      const rows = reopened.prepare('SELECT id, title FROM tasks ORDER BY seq').all<{ id: string; title: string }>();
      assert.deepEqual(
        rows.map((row) => row.id),
        ['SAT-1'],
      );
      assert.equal(rows[0].title, 'До бэкапа');
    } finally {
      reopened.close();
    }

    // pre-restore снимок содержит состояние на момент откатa (2 задачи).
    const preRestore = backupService.require(result.preRestoreBackup);
    assert.equal(readBackupTasks(preRestore.path).length, 2);
  });

  it('создаёт снимок без WAL/SHM и различает копии по времени', () => {
    const { backupService } = fixture.app;
    const first = backupService.create('first');
    const second = backupService.create('second');

    assert.notEqual(first.name, second.name);
    for (const record of [first, second]) {
      assert.equal(fs.existsSync(`${record.path}-wal`), false);
      assert.equal(fs.existsSync(`${record.path}-shm`), false);
    }
    assert.equal(backupService.list().length, 2);
  });

  it('перезаписывает копию, созданную в ту же секунду', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-backup-fixed-'));
    const dbPath = path.join(workDir, 'tracker.db');
    const fixedClock: Clock = { now: () => '2026-05-01T10:00:00.000Z' };
    const app = createContainer({
      config: { dbPath, backupDir: path.join(workDir, 'backups'), idPrefix: 'SAT' },
      db: new NodeSqliteDatabase({ file: dbPath }),
      clock: fixedClock,
      logger: new SilentLogger(),
    });

    try {
      const first = app.backupService.create('first');
      const second = app.backupService.create('second');
      assert.equal(first.name, second.name);
      assert.equal(app.backupService.list().length, 1);
      assert.ok(fs.existsSync(second.path));
    } finally {
      app.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
