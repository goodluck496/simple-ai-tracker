import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';

type SetupCommand = Pick<ProcessRequest, 'command' | 'args'>;
interface Manifest { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; }

/** Prepare the isolated checkout before spending tokens on an agent. */
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
    const prepared = (await this.read(marker)) === signature;
    if (!prepared || missing.length) {
      for (const command of setup) await this.executor.run({ ...command, cwd, signal, onProgress: progress });
      missing = await this.missingDependencies(cwd, manifest);
      if ((!prepared || missing.length) && !setup.length && lock) {
        try {
          if ((await fs.lstat(path.join(cwd, 'node_modules'))).isSymbolicLink()) {
            throw new Error('Cannot run npm ci against shared node_modules. Configure isolated dependencies/setup first.');
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        progress('Worker setup: npm ci in isolated worktree (before agent).\n');
        await this.executor.run({ command: 'npm', args: ['ci', '--include=dev', '--no-audit', '--no-fund'], cwd, signal, onProgress: progress });
        missing = await this.missingDependencies(cwd, manifest);
      }
      if (missing.length) throw new Error(`Worktree dependencies are incomplete: ${missing.slice(0, 8).join(', ')}. Configure setup or repair the installation; no agent was started.`);
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, signature, 'utf8');
    }
  }

  private async missingDependencies(cwd: string, manifest: Manifest): Promise<string[]> {
    const require = createRequire(path.join(cwd, 'package.json'));
    const missing: string[] = [];
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (manifest.optionalDependencies?.[name]) continue;
      try {
        // The manifest can survive an interrupted install while its entry files do not.
        const packagePath = path.join(cwd, 'node_modules', name, 'package.json');
        const installed = JSON.parse(await fs.readFile(packagePath, 'utf8')) as { exports?: unknown };
        if (!name.startsWith('@types/')) {
          if (!installed.exports) {
            const entry = require.resolve(name);
            if (path.isAbsolute(entry)) await fs.access(entry);
          } else {
            // SDK/theme packages may advertise an absent or type-only root but valid subpath imports.
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
