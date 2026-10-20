import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TrackerConfig } from '../core/config.js';
import { TrackerError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface StoredImage {
  readonly url: string;
  readonly fileName: string;
  readonly size: number;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const IMAGE_FILE_PATTERN = /^[a-z0-9]{8,64}\.(png|jpg|webp|gif)$/;

/**
 * Хранение скриншотов карточек.
 *
 * Картинки (вставка из буфера, drag&drop, файл) приходят data-URL'ом, сохраняются
 * отдельными файлами в `data/images`, а в карточке остаётся лёгкая ссылка
 * `/api/images/<файл>`. Так база не раздувается base64-мусором.
 */
export class ImageService {
  public constructor(
    private readonly config: TrackerConfig,
    private readonly logger?: Logger,
  ) {}

  public get directory(): string {
    return this.config.imagesDir;
  }

  /** Сохраняет data-URL в файл и возвращает публичный URL. */
  public storeDataUrl(dataUrl: string): StoredImage {
    const match = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec((dataUrl ?? '').trim());
    if (!match) {
      throw new TrackerError('VALIDATION_FAILED', 'Ожидается data-URL изображения (data:image/png;base64,…).');
    }

    const mime = match[1].toLowerCase();
    const extension = ALLOWED_MIME[mime];
    if (!extension) {
      throw new TrackerError('VALIDATION_FAILED', `Неподдерживаемый тип изображения: ${mime}.`, {
        allowed: Object.keys(ALLOWED_MIME),
      });
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) {
      throw new TrackerError('VALIDATION_FAILED', 'Пустое изображение.');
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new TrackerError('VALIDATION_FAILED', `Изображение больше ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} МБ.`);
    }

    fs.mkdirSync(this.config.imagesDir, { recursive: true });
    const fileName = `${crypto.randomBytes(12).toString('hex')}.${extension}`;
    fs.writeFileSync(path.join(this.config.imagesDir, fileName), buffer);
    this.logger?.info('Сохранено изображение', { fileName, size: buffer.length });

    return { url: `/api/images/${fileName}`, fileName, size: buffer.length };
  }

  /** Путь к файлу изображения (для раздачи) или null, если имя небезопасно/файла нет. */
  public resolveFile(fileName: string): string | null {
    if (!IMAGE_FILE_PATTERN.test(fileName)) return null;
    const absolute = path.join(this.config.imagesDir, fileName);
    return fs.existsSync(absolute) ? absolute : null;
  }
}
