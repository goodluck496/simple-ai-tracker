import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessExecutor } from '../runners/process-executor.js';
import type { TrackerChannel } from './mcp-client.js';
import { AutomationTool } from '../../../../shared/automation/protocol.js';
import { ProjectAction, PROJECT_LIMITS, type ProjectInput, type ProjectRequest, type ProjectResult } from '../../../../shared/automation/project.js';
import { WindowsFolderPicker, type FolderPicker } from './folder-picker.js';
import { WorkerModelCatalog } from './model-catalog.js';
import { RunCleanup } from './run-cleanup.js';
import type { ExecutionControl } from './execution-supervisor.js';

export class ProjectWorker {
  private readonly executor = new ProcessExecutor();
  public constructor(private readonly channel: TrackerChannel, private readonly workerId: string, private readonly picker: FolderPicker = new WindowsFolderPicker(),
    private readonly models: Pick<WorkerModelCatalog, 'list'> = new WorkerModelCatalog(), private readonly execution?: ExecutionControl) {}
  public async tick(): Promise<void> {
    const request = await this.channel.call<ProjectRequest | null>(AutomationTool.HostPoll, { workerId: this.workerId, platform: process.platform, ...(this.execution ? { result: { execution: this.execution.status() } } : {}) });
    if (!request) return;
    let result: ProjectResult | undefined; let error: string | undefined;
    try { result = await this.execute(request); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    await this.channel.call(AutomationTool.HostComplete, { id: request.id, leaseToken: request.token, result, error });
  }
  public async execute(input: ProjectInput): Promise<ProjectResult> {
    if (input.action === ProjectAction.StartWorker || input.action === ProjectAction.StopWorker) {
      if (!this.execution) throw new Error('Этот worker не поддерживает управление исполнителем.');
      return { path: '', execution: await (input.action === ProjectAction.StartWorker ? this.execution.start() : this.execution.stop()) };
    }
    if (input.action === ProjectAction.Cleanup) {
      if (!input.cleanup) throw new Error('Missing cleanup identity.');
      return { path: input.path, cleanup: await new RunCleanup(this.executor).execute(input.cleanup, AbortSignal.timeout(PROJECT_LIMITS.cleanupMs - 5000)) };
    }
    if (input.action === ProjectAction.Models) {
      if (!input.catalog) throw new Error('Не указано подключение моделей.');
      return { path: '', models: await this.models.list(input.catalog) };
    }
    if (input.action === ProjectAction.PickFolder) {
      const selected = await this.picker.pick(input.path);
      return selected ? { path: await realpath(selected) } : { path: input.path, cancelled: true };
    }
    const target = input.path || os.homedir();
    if (!path.isAbsolute(target)) throw new Error('Укажите абсолютную папку на машине worker.');
    const directory = await realpath(target);
    if (input.action === ProjectAction.Browse) {
      const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
      return { path: directory, parent: path.dirname(directory), truncated: entries.length > PROJECT_LIMITS.maxEntries,
        directories: entries.slice(0, PROJECT_LIMITS.maxEntries).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) })) };
    }
    const root = (await this.git(directory, ['rev-parse', '--show-toplevel'])).trim();
    if (input.action === ProjectAction.CreateBranch) {
      const branch = input.newBranch ?? ''; const base = input.baseBranch ?? '';
      if (branch.startsWith('-') || base.startsWith('-') || !base || !branch) throw new Error('Некорректное имя ветки.');
      await this.git(root, ['check-ref-format', '--branch', branch]);
      await this.git(root, ['show-ref', '--verify', `refs/heads/${base}`]);
      await this.git(root, ['branch', '--', branch, base]);
    }
    const branches = (await this.git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).trim().split('\n').map((v) => v.trim()).filter(Boolean);
    if (branches.length > PROJECT_LIMITS.maxEntries) throw new Error('Слишком много веток для выбора.');
    let scripts: string[] = []; let hasLockfile = false;
    try {
      const file = path.join(root, 'package.json');
      if ((await stat(file)).size <= PROJECT_LIMITS.packageBytes) {
        const json = JSON.parse(await readFile(file, 'utf8')) as { scripts?: Record<string, unknown> };
        scripts = Object.entries(json.scripts ?? {}).filter(([, value]) => typeof value === 'string').map(([key]) => key).slice(0, PROJECT_LIMITS.maxEntries);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Не удалось прочитать package.json проекта.'); }
    try { await stat(path.join(root, 'package-lock.json')); hasLockfile = true; } catch { /* non-npm projects have no lockfile */ }
    return { path: root, branches, currentBranch: (await this.git(root, ['branch', '--show-current'])).trim(), scripts, hasLockfile };
  }
  private async git(cwd: string, args: string[]): Promise<string> {
    return this.executor.run({ command: 'git', args, cwd, signal: AbortSignal.timeout(PROJECT_LIMITS.commandMs) });
  }
}
