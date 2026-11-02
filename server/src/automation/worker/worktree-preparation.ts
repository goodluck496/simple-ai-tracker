import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';

type SetupCommand = Pick<ProcessRequest, 'command' | 'args'>;
interface Manifest { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; }

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Prepare dependencies before mutations/checks; API source analysis may run concurrently. */
export class WorktreePreparation {
  public constructor(private readonly executor: ProcessExecutor) {}

  public async inspect(cwd: string): Promise<string[]> {
    const text = await this.read(path.join(cwd, 'package.json'));
    return this.missingDependencies(cwd, text ? JSON.parse(text) as Manifest : {});
  }

  public async prepare(cwd: string, setup: readonly SetupCommand[], signal: AbortSignal, progress: (text: string) => void): Promise<void> {
    const git = (args: string[]) => this.executor.run({ command: 'git', args, cwd, signal });
    if ((await git(['ls-files', '--', '.sat'])).trim()) throw new Error('Worker runtime .sat must not be tracked by Git.');
    const exclude = path.resolve(cwd, (await git(['rev-parse', '--git-path', 'info/exclude'])).trim());
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    const exclusions = await this.read(exclude);
    if (!exclusions.split(/\r?\n/).includes('/.sat/')) await fs.appendFile(exclude, '\n/.sat/\n', 'utf8');

    const manifestText = await this.read(path.join(cwd, 'package.json'));
    const lock = await this.read(path.join(cwd, 'package-lock.json'));
    const signature = createHash('sha256').update(JSON.stringify({ manifestText, lock, setup, node: process.version, platform: process.platform })).digest('hex');
    const marker = path.join(cwd, '.sat', 'setup-complete');
    const manifest = manifestText ? JSON.parse(manifestText) as Manifest : {};
    let missing = await this.missingDependencies(cwd, manifest);
    const markerContent = (await this.read(marker)).trim();
    let prepared = false;
    let expired = false;
    if (markerContent) {
      try {
        const parsed = JSON.parse(markerContent) as { signature?: string; timestamp?: number };
        if (parsed.signature === signature) {
          const age = Date.now() - (parsed.timestamp ?? 0);
          if (age < ONE_WEEK_MS) {
            prepared = true;
          } else {
            expired = true;
          }
        }
      } catch {
        if (markerContent === signature) prepared = true;
      }
    }

    if (prepared && !missing.length) {
      progress('Подготовка: зависимости актуальны (срок < 7 дней), повторная установка npm пропущена.\n');
    } else if (expired) {
      progress('Подготовка: срок действия зависимостей истёк (> 7 дней; протухли), запуск обновления.\n');
    } else {
      progress('Подготовка: проверены манифест и установленные зависимости.\n');
    }

    if (!prepared || missing.length) {
      for (const [index, command] of setup.entries()) {
        progress(`Команды подготовки: ${index}/${setup.length} (${Math.floor(index * 100 / setup.length)}%). Сейчас: ${command.command}.\n`);
        await this.executor.run({ ...command, cwd, signal, compactProgress: true, onProgress: progress });
        progress(`Команды подготовки: ${index + 1}/${setup.length} (${Math.floor((index + 1) * 100 / setup.length)}%).\n`);
      }
      missing = await this.missingDependencies(cwd, manifest);
      if ((!prepared || missing.length) && !setup.length && lock) {
        try {
          if ((await fs.lstat(path.join(cwd, 'node_modules'))).isSymbolicLink()) {
            throw new Error('Cannot run npm ci against shared node_modules. Configure isolated dependencies/setup first.');
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        progress('Worker setup: npm ci in isolated worktree.\n');
        progress('Команды подготовки: 0/1 (0%). Сейчас: npm ci.\n');
        await this.executor.run({ command: 'npm', args: ['ci', '--include=dev', '--no-audit', '--no-fund', '--loglevel=http'], cwd, signal, compactProgress: true, onProgress: progress });
        progress('Команды подготовки: 1/1 (100%). Проверка установленных пакетов.\n');
        missing = await this.missingDependencies(cwd, manifest);
      }
      if (missing.length) throw new Error(`Worktree dependencies are incomplete: ${missing.slice(0, 8).join(', ')}. Configure setup or repair the installation; source writes and checks are blocked.`);
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, JSON.stringify({ signature, timestamp: Date.now() }), 'utf8');
    }
    progress('Подготовка зависимостей завершена; проверка пакетов пройдена.\n');
  }

  private async missingDependencies(cwd: string, manifest: Manifest): Promise<string[]> {
    const require = createRequire(path.join(cwd, 'package.json'));
    const missing: string[] = [];
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (manifest.optionalDependencies?.[name]) continue;
      try {
        const packagePath = path.join(cwd, 'node_modules', name, 'package.json');
        const installed = JSON.parse(await fs.readFile(packagePath, 'utf8')) as { exports?: unknown };
        if (!name.startsWith('@types/')) {
          if (!installed.exports) {
            const entry = require.resolve(name);
            if (path.isAbsolute(entry)) await fs.access(entry);
          } else {
            const targets = this.exportTargets(installed.exports).filter((target) => !target.endsWith('/package.json'));
            const present = await Promise.all(targets.map(async (target) => {
              const prefix = target.includes('*') ? target.slice(0, target.indexOf('*')) || '.' : target;
              try { await fs.access(path.resolve(path.dirname(packagePath), prefix)); return true; } catch { return false; }
            }));
            if (targets.length && !present.some(Boolean)) throw new Error('Runtime exports are absent.');
          }
        }
      } catch { missing.push(name); }
    }
    return missing;
  }

  private exportTargets(exports: unknown): string[] {
    if (typeof exports === 'string') return exports.startsWith('./') ? [exports] : [];
    if (!exports || typeof exports !== 'object') return [];
    return Object.entries(exports).filter(([condition]) => condition !== 'types')
      .flatMap(([, value]) => this.exportTargets(value));
  }

  private async read(file: string): Promise<string> {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
}
