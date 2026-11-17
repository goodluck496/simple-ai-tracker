import fs from 'node:fs/promises';
import path from 'node:path';
import { detectPackageManager, type PackageManagerInfo } from '../../../shared/automation/project.js';
import type { CheckCommand } from '../../../shared/automation/contracts.js';

export async function assertProjectCheckScripts(cwd: string, checks: CheckCommand[]): Promise<void> {
  const scripts = checks.flatMap(check => {
    const executable = check.command.split(/[\\/]/).at(-1) ?? '';
    if (!/^(npm|pnpm)(?:\.cmd|\.exe)?$/i.test(executable)) return [];
    const [action, script] = check.args;
    return ['test', 't', 'tst'].includes(action) ? ['test'] : ['run', 'run-script'].includes(action) && script && !script.startsWith('-') ? [script] : [];
  });
  if (!scripts.length) return;
  let available: Record<string, unknown> = {};
  try { available = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'))?.scripts ?? {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const missing = [...new Set(scripts)].filter(name => !Object.hasOwn(available, name) || typeof available[name] !== 'string');
  if (missing.length) throw new Error(`В package.json текущей рабочей копии отсутствуют скрипты обязательных проверок: ${missing.join(', ')}. Исправьте команды проверок в проекте и продолжите запуск с обновлёнными проверками.`);
}


export async function readProjectPackageManager(cwd: string, declared?: unknown): Promise<PackageManagerInfo> {
  if (declared === undefined) {
    try { declared = (JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { packageManager?: unknown })?.packageManager; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const exists = async (name: string) => {
    try { return (await fs.stat(path.join(cwd, name))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const pnpmLock = await exists('pnpm-lock.yaml');
  const packageManager = detectPackageManager(declared, pnpmLock || await exists('pnpm-workspace.yaml'));
  return { packageManager, hasLockfile: packageManager === 'pnpm' ? pnpmLock : await exists('package-lock.json') };
}
