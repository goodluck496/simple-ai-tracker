import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcessExecutor } from './runners/process-executor.js';

export async function selectedDirectory(selected: string): Promise<string> {
  if (!path.isAbsolute(selected)) throw new Error('Укажите абсолютный путь на компьютере worker.');
  const info = await fs.stat(selected);
  if (info.isDirectory()) return fs.realpath(selected);
  if (info.isFile() && path.basename(selected) === 'package.json') return fs.realpath(path.dirname(selected));
  throw new Error('Выберите папку проекта или файл package.json.');
}

/** Resolve the same application inside a source, child or integration checkout. */
export async function projectInCheckout(root: string, relative: string): Promise<string> {
  if (!relative) return root;
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Папка приложения должна находиться внутри репозитория.');
  }
  const directory = path.join(root, relative);
  const manifest = path.join(directory, 'package.json');
  try {
    if (await fs.realpath(directory) === directory && (await fs.lstat(manifest)).isFile()) return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
  }
  throw new Error(`В рабочей копии нужен файл ${path.join(relative, 'package.json')} внутри репозитория.`);
}

export async function projectLocation(selected: string, executor: ProcessExecutor, signal: AbortSignal) {
  const directory = await selectedDirectory(selected);
  const top = await executor.run({ command: 'git', args: ['rev-parse', '--show-toplevel'], cwd: directory, signal });
  const root = await fs.realpath(top.trim());
  const relative = path.relative(root, directory);
  await projectInCheckout(root, relative);
  return { root, directory, relative };
}
