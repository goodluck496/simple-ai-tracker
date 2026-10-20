import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { createContainer, type AppContainer } from '../bootstrap/container.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';
import { BackupScheduler } from './backup-scheduler.js';
import type { Clock } from './task-service.js';

/** Часы с шагом в секунду: имена бэкапов не слипаются внутри одного теста. */
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
  readonly backupDir: string;
  readonly workDir: string;
}

function createFixture(): Fixture {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-scheduler-'));
  const backupDir = path.join(workDir, 'data', 'backups');
  const dbPath = path.join(workDir, 'data', 'tracker.db');

  const app = createContainer({
    config: { dbPath, backupDir, idPrefix: 'SAT' },
    db: new NodeSqliteDatabase({ file: dbPath }),
    clock: new StepClock(),
    logger: new SilentLogger(),
  });

  return { app, backupDir, workDir };
}

/** Сдвигает время создания файлов бэкапа в прошлое, чтобы проверить интервал и суточный лимит. */
function ageBackups(directory: string, minutes: number): void {
  const stamp = new Date(Date.now() - minutes * 60 * 1000);
  for (const file of fs.readdirSync(directory)) {
    fs.utimesSync(path.join(directory, file), stamp, stamp);
  }
}

describe('BackupScheduler', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.app.close();
    fs.rmSync(fixture.workDir, { recursive: true, force: true });
  });

  it('не делает второй снимок, пока не истёк интервал', () => {
    const scheduler = new BackupScheduler(fixture.app.backupService, {
      enabled: true,
      intervalHours: 12,
      maxPerDay: 2,
      keep: 20,
    });

    assert.ok(scheduler.runOnce('startup'));
    assert.equal(scheduler.runOnce('scheduled'), null, 'второй снимок в пределах интервала пропускается');
    assert.equal(fixture.app.backupService.list().length, 1);
  });

  it('ограничивает автоматические бэкапы двумя в сутки', () => {
    const scheduler = new BackupScheduler(fixture.app.backupService, {
      enabled: true,
      intervalHours: 0.05,
      maxPerDay: 2,
      keep: 20,
    });

    assert.ok(scheduler.runOnce('startup'));
    ageBackups(fixture.backupDir, 10);
    assert.ok(scheduler.runOnce('scheduled'));
    ageBackups(fixture.backupDir, 10);

    assert.equal(scheduler.runOnce('scheduled'), null, 'третий бэкап за сутки запрещён');
    assert.equal(fixture.app.backupService.list().length, 2);
  });

  it('ручной бэкап не подчиняется расписанию', () => {
    const scheduler = new BackupScheduler(fixture.app.backupService, {
      enabled: true,
      intervalHours: 12,
      maxPerDay: 2,
      keep: 20,
    });

    assert.ok(scheduler.runOnce('startup'));
    for (let index = 0; index < 3; index += 1) fixture.app.backupService.create('manual');

    assert.equal(fixture.app.backupService.list().length, 4);
    assert.equal(scheduler.runOnce('scheduled'), null);
  });

  it('считает суточный лимит по календарным суткам, а не по возрасту файлов', () => {
    const scheduler = new BackupScheduler(fixture.app.backupService, {
      enabled: true,
      intervalHours: 12,
      maxPerDay: 1,
      keep: 20,
    });

    const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const backup = fixture.app.backupService.create('manual');
    fs.utimesSync(backup.path, yesterday, yesterday);

    assert.equal(scheduler.shouldCreate(new Date()), true, 'вчерашние снимки в лимит не входят');
  });
});
