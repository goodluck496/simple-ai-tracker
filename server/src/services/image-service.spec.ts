import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { createContainer, type AppContainer } from '../bootstrap/container.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';
import { TrackerError } from '../core/errors.js';

/** 1×1 PNG в base64 — минимальная валидная картинка для теста. */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('ImageService и скриншоты карточек', () => {
  let workDir: string;
  let app: AppContainer;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-images-'));
    app = createContainer({
      config: {
        dbPath: path.join(workDir, 'tracker.db'),
        backupDir: path.join(workDir, 'backups'),
        imagesDir: path.join(workDir, 'images'),
        idPrefix: 'SAT',
      },
      db: new NodeSqliteDatabase({ file: path.join(workDir, 'tracker.db') }),
      logger: new SilentLogger(),
    });
  });

  afterEach(() => {
    app.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('сохраняет data-URL в файл и отдаёт ссылку /api/images/<файл>', () => {
    const stored = app.imageService.storeDataUrl(PNG_DATA_URL);
    assert.match(stored.fileName, /^[a-f0-9]{24}\.png$/);
    assert.equal(stored.url, `/api/images/${stored.fileName}`);
    assert.ok(stored.size > 0);

    const filePath = app.imageService.resolveFile(stored.fileName);
    assert.ok(filePath && fs.existsSync(filePath));
    assert.equal(fs.readFileSync(filePath).subarray(1, 4).toString('utf8'), 'PNG');
  });

  it('отклоняет небезопасные имена и неподдерживаемые типы', () => {
    assert.equal(app.imageService.resolveFile('../../etc/passwd'), null);
    assert.equal(app.imageService.resolveFile('not-an-image.txt'), null);
    assert.throws(
      () => app.imageService.storeDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='),
      (error: unknown) => error instanceof TrackerError && error.code === 'VALIDATION_FAILED',
    );
    assert.throws(
      () => app.imageService.storeDataUrl('не data-url'),
      (error: unknown) => error instanceof TrackerError && error.code === 'VALIDATION_FAILED',
    );
  });

  it('прикрепляет скриншоты при создании и заменяет набор при обновлении', () => {
    const first = app.imageService.storeDataUrl(PNG_DATA_URL);
    const second = app.imageService.storeDataUrl(PNG_DATA_URL);

    const task = app.taskService.createTask({ title: 'Со скриншотом', images: [first.url] });
    assert.deepEqual(
      task.images.map((image) => image.url),
      [first.url],
    );

    const updated = app.taskService.updateTask({ id: task.id, images: [second.url] });
    assert.deepEqual(
      updated.images.map((image) => image.url),
      [second.url],
      'набор картинок заменяется целиком',
    );

    const cleared = app.taskService.updateTask({ id: task.id, images: [] });
    assert.equal(cleared.images.length, 0);
  });
});
