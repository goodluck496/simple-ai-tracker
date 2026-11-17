import fs from 'node:fs/promises';
import path from 'node:path';
import { AUTOMATION_LIMITS } from '../../../shared/automation/contracts.js';
import { SCREENSHOT_LIMIT, SCREENSHOT_PATH } from '../../../shared/automation/screenshots.js';

export async function readVisualArtifacts(cwd: string, candidates: string[]): Promise<{ path: string; url: string }[]> {
  if (!candidates.length) return [];
  const root = await fs.realpath(cwd);
  const images: { path: string; url: string }[] = [];
  for (const relative of new Set(candidates.map(file => file.replaceAll('\\', '/')))) {
    const extension = path.extname(relative).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) continue;
    if (!SCREENSHOT_PATH.test(relative) && relative.split('/').some(part => ['.git', '.sat', '.codegraph'].includes(part.toLowerCase()))) continue;
    if (path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.split('/').includes('..')) continue;
    try {
      const file = await fs.realpath(path.resolve(root, relative));
      const local = path.relative(root, file).split(path.sep).join('/');
      const expected = path.posix.normalize(relative);
      if (process.platform === 'win32' ? local.toLowerCase() !== expected.toLowerCase() : local !== expected) continue;
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > AUTOMATION_LIMITS.imageBytes) continue;
      const bytes = await fs.readFile(file);
      if (bytes.length > AUTOMATION_LIMITS.imageBytes) continue;
      const png = extension === '.png';
      const webp = extension === '.webp';
      const valid = png ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        : webp ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          : bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
      if (!valid) continue;
      const format = png ? 'png' : webp ? 'webp' : 'jpeg';
      images.push({ path: relative, url: `data:image/${format};base64,${bytes.toString('base64')}` });
      if (images.length >= SCREENSHOT_LIMIT) break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return images;
}
