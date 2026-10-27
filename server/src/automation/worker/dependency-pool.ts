import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ProcessExecutor } from '../runners/process-executor.js';
import { ExecutionScope } from '../runners/execution-scope.js';
import { RuntimeCoordinator, type RuntimeLease } from './runtime-coordinator.js';
import { RunWorkspace } from './run-workspace.js';
import { ImmutableDependencies } from './immutable-dependencies.js';
import { TaskEnvironment } from '../runners/task-environment.js';

interface Links { key: string; signature: string; names: string[]; }
interface Ready { sid?: string; }
export class DependencyPool {
  private readonly coordinator: RuntimeCoordinator;
  private readonly readers = new Map<string, RuntimeLease>();
  private readonly protection: ImmutableDependencies;
  private readonly root: string;
  public constructor(common: string, private readonly executor: ProcessExecutor) {
    this.root = path.join(common, 'sat-runtime', 'dependencies');
    this.coordinator = new RuntimeCoordinator(path.join(common, 'sat-runtime', 'coordination.sqlite'));
    this.protection = new ImmutableDependencies(executor);
  }
  public close(): void { for (const lease of this.readers.values()) lease.release(); this.readers.clear(); this.coordinator.close(); }
  public child(pid: number, active: boolean): void { for (const lease of this.readers.values()) lease.child(pid, active); }
  public async signature(cwd: string): Promise<string> {
    return createHash('sha256').update(await this.text(path.join(cwd, 'package.json'))).update('\0')
      .update(await this.text(path.join(cwd, 'package-lock.json'))).digest('hex');
  }
  public async state(cwd: string): Promise<Links | undefined> {
    const text = await this.text(path.join(cwd, '.sat', 'dependency-links.json')); return text ? JSON.parse(text) as Links : undefined;
  }
  public async link(cwd: string, signal: AbortSignal, progress: (text: string) => void): Promise<{ key?: string; reason?: string }> {
    const manifestText = await this.text(path.join(cwd, 'package.json')); const lockText = await this.text(path.join(cwd, 'package-lock.json'));
    if (!manifestText || !lockText) return { reason: 'No npm lockfile; isolated dependencies.' };
    if (process.platform !== 'win32' && os.userInfo().uid === 0) return { reason: 'Privileged POSIX user can bypass readonly permissions; isolated dependencies.' };
    const manifest = JSON.parse(manifestText) as { workspaces?: unknown; scripts?: Record<string, string> };
    const lock = JSON.parse(lockText) as { packages?: Record<string, { link?: boolean }> };
    if (manifest.workspaces || ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish'].some(name => manifest.scripts?.[name])
      || Object.values(lock.packages ?? {}).some(pkg => pkg.link) || await this.text(path.join(cwd, '.npmrc')))
      return { reason: 'Workspace/local links, root install hooks or project npmrc require isolated dependencies.' };
    const previous = await this.state(cwd);
    if (previous) await RunWorkspace.localDirectory(cwd, 'node_modules');
    if (!previous) {
      try { await fs.access(path.join(cwd, 'node_modules')); return { reason: 'Existing isolated dependencies retained.' }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const version = (await this.executor.run({ command: 'npm', args: ['--version'], cwd, signal })).trim();
    const config = JSON.parse(await this.executor.run({ command: 'npm', args: ['config', 'list', '--json'], cwd, signal })) as Record<string, unknown>;
    const configKeys = ['registry', 'install-strategy', 'legacy-peer-deps', 'strict-peer-deps', 'ignore-scripts', 'omit', 'include', 'optional', 'bin-links', 'engine-strict', 'cpu', 'os', 'libc', 'install-links', 'script-shell', 'node-options'];
    const options = Object.fromEntries(configKeys.map(key => [key, config[key]]));
    const signature = await this.signature(cwd);
    const key = createHash('sha256').update(JSON.stringify({ signature, version, options, node: process.version,
      platform: process.platform, arch: process.arch, user: os.userInfo().username, includeDev: true })).digest('hex');
    if (previous && (previous.key !== key || previous.signature !== signature)) return { reason: 'Installation settings changed; private dependencies required.' };
    const directory = this.cachePath(key); const modules = path.join(directory, 'node_modules');
    const lease = await this.coordinator.acquire(`dependencies:${key}`, signal);
    const scope = ExecutionScope.current;
    try {
      return await ExecutionScope.run({ ...scope, child: (pid, active) => { scope?.child?.(pid, active); lease.child(pid, active); } }, async () => {
        await fs.mkdir(directory, { recursive: true });
        if (await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Managed dependency directory is redirected; sharing refused.');
        let ready: Ready | undefined;
        const metadata = path.join(this.root, '.metadata', `${key}.json`);
        const readyText = await this.text(metadata); if (readyText) ready = JSON.parse(readyText) as Ready;
        if (!ready) {
          await this.protection.unprotect(directory, undefined, signal);
          try {
            await fs.access(modules);
            await this.safeRemove(modules);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await fs.writeFile(path.join(directory, 'package.json'), manifestText, 'utf8');
          await fs.writeFile(path.join(directory, 'package-lock.json'), lockText, 'utf8');
          const temporary = path.join(directory, '.install-tmp'); const downloads = path.join(directory, '.install-cache');
          await fs.mkdir(temporary, { recursive: true }); await fs.mkdir(downloads, { recursive: true });
          const environment = TaskEnvironment.create();
          delete environment.PORT; delete environment.SAT_PORT; delete environment.NODE_COMPILE_CACHE;
          Object.assign(environment, { TMP: temporary, TEMP: temporary, TMPDIR: temporary, XDG_CACHE_HOME: temporary, npm_config_cache: downloads });
          progress('Preparing immutable npm dependency cache before agent execution.\n');
          await this.executor.run({ command: 'npm', args: ['ci', '--include=dev', '--no-audit', '--no-fund'], cwd: directory, env: environment, signal, onProgress: progress });
          await this.protection.inspect(directory);
          await this.safeRemove(temporary); await this.safeRemove(downloads);
          await fs.mkdir(modules, { recursive: true });
          ready = { sid: await this.protection.protect(directory, signal) };
          await RunWorkspace.atomic(metadata, ready);
        } else await this.protection.verify(directory);
        const destination = path.join(cwd, 'node_modules');
        if (!this.readers.has(cwd)) {
          const reader = this.coordinator.tryAcquire(`dependency-reader:${key}:${createHash('sha256').update(cwd).digest('hex')}`);
          if (!reader) throw new Error('Dependency checkout is already in use.');
          this.readers.set(cwd, reader);
        }
        const names: string[] = [];
        for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
          if (entry.name === '.bin' || entry.name === '.cache') continue;
          if (entry.name.startsWith('@') && entry.isDirectory()) for (const pkg of await fs.readdir(path.join(modules, entry.name))) names.push(`${entry.name}/${pkg}`);
          else if (!entry.name.startsWith('.')) names.push(entry.name);
        }
        await RunWorkspace.localDirectory(cwd, 'node_modules');
        // Persist ownership before creating links: interrupted attachment can be safely resumed/detached.
        await RunWorkspace.atomic(path.join(cwd, '.sat', 'dependency-links.json'), { key, signature, names });
        for (const name of names) {
          const target = path.join(modules, name); const link = this.packagePath(destination, name);
          if (name.includes('/')) await RunWorkspace.localDirectory(cwd, `node_modules/${name.split('/')[0]}`);
          try {
            const info = await fs.lstat(link);
            if (!info.isSymbolicLink() || await fs.realpath(link) !== await fs.realpath(target)) throw new Error('Dependency link ownership changed.');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
          }
        }
        await RunWorkspace.localDirectory(cwd, 'node_modules/.bin');
        try { await fs.cp(path.join(modules, '.bin'), path.join(destination, '.bin'), { recursive: true, verbatimSymlinks: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await RunWorkspace.localDirectory(cwd, 'node_modules/.cache');
        return { key };
      });
    } finally { lease.release(); }
  }
  public async detach(cwd: string): Promise<void> {
    const state = await this.state(cwd); if (!state) return;
    const modules = path.join(cwd, 'node_modules');
    const cache = path.join(this.cachePath(state.key), 'node_modules');
    const info = await fs.lstat(modules); if (info.isSymbolicLink()) throw new Error('Refusing to modify an external node_modules link.');
    await RunWorkspace.localDirectory(cwd, 'node_modules');
    for (const name of state.names) {
      const link = this.packagePath(modules, name);
      if (name.includes('/')) await RunWorkspace.localDirectory(cwd, `node_modules/${name.split('/')[0]}`);
      try {
        const stat = await fs.lstat(link);
        if (stat.isSymbolicLink()) {
          if (await fs.realpath(link) !== await fs.realpath(this.packagePath(cache, name))) throw new Error('Dependency link points outside its managed cache.');
          await fs.unlink(link);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.readers.get(cwd)?.release(); this.readers.delete(cwd);
    await fs.unlink(path.join(cwd, '.sat', 'dependency-links.json'));
  }
  public async pruneUnused(key: string, signal: AbortSignal): Promise<void> {
    const lease = await this.coordinator.acquire(`dependencies:${key}`, signal);
    try {
      if (this.coordinator.held(`dependency-reader:${key}:`)) throw new Error('Dependency cache is still in use.');
      const directory = this.cachePath(key); const modules = path.join(directory, 'node_modules');
      const metadata = path.join(this.root, '.metadata', `${key}.json`);
      const ready = JSON.parse(await this.text(metadata)) as Ready;
      await this.protection.unprotect(directory, ready.sid, signal); await this.safeRemove(directory); await fs.unlink(metadata);
    } finally { lease.release(); }
  }
  private cachePath(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid managed cache key.');
    return path.join(this.root, key);
  }
  private packagePath(root: string, name: string): string {
    const parts = name.split('/');
    if (parts.length > 2 || parts.some(part => !part || part === '.' || part === '..' || !/^[@\w.-]+$/.test(part))) throw new Error('Invalid dependency link path.');
    return path.join(root, ...parts);
  }
  private async safeRemove(target: string): Promise<void> {
    const real = await fs.realpath(target); const base = await fs.realpath(this.root); const relative = path.relative(base, real);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || (await fs.lstat(target)).isSymbolicLink()) throw new Error('Refusing to remove redirected dependency cache.');
    await fs.rm(target, { recursive: true, force: true });
  }
  private async text(file: string): Promise<string> {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
}
