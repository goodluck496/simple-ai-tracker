import fs from 'node:fs/promises';
import path from 'node:path';
import { SCREENSHOT_LIMIT, SCREENSHOT_MAX_BYTES, SCREENSHOT_PATH } from '../../../../shared/automation/screenshots.js';

export async function readStageScreenshots(cwd: string, screenshots: unknown): Promise<string[]> {
  if (screenshots === undefined) return [];
  if (!Array.isArray(screenshots) || screenshots.length > SCREENSHOT_LIMIT) throw new Error('Invalid stage screenshot list.');
  const root = await fs.realpath(cwd);
  const images: string[] = [];
  for (const name of new Set(screenshots)) {
    if (typeof name !== 'string' || !SCREENSHOT_PATH.test(name)) throw new Error('Screenshot must be a PNG in .sat/screenshots.');
    const file = await fs.realpath(path.join(root, name));
    if (path.relative(root, file).split(path.sep).join('/') !== name) throw new Error('Screenshot path must stay inside the worktree without links.');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > SCREENSHOT_MAX_BYTES) throw new Error('Screenshot must be a regular PNG up to 2 MB.');
    const bytes = await fs.readFile(file);
    if (bytes.length > SCREENSHOT_MAX_BYTES || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG screenshot.');
    images.push(`data:image/png;base64,${bytes.toString('base64')}`);
  }
  return images;
}
