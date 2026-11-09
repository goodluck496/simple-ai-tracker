import { readdir, readFile, stat, realpath, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PostOperationRunner } from './post-operation-runner.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import type { TrackerChannel } from './mcp-client.js';
import { AutomationTool } from '../../../../shared/automation/protocol.js';
import { ProjectAction, PROJECT_LIMITS, type PreviewPatch, type ProjectInput, type ProjectRequest, type ProjectResult } from '../../../../shared/automation/project.js';
import { WindowsFolderPicker, type FolderPicker } from './folder-picker.js';
import { WorkerModelCatalog } from './model-catalog.js';
import { researchProject } from './project-research.js';
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
    if (input.action === ProjectAction.UnloadOllama) {
      if (!input.catalog || !input.model) throw new Error('Укажите подключение Ollama и модель.');
      await new WorkerModelCatalog().unload(input.catalog.connection, input.model);
      return { path: '', unloaded: input.model };
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
    if (input.action === ProjectAction.PreviewPatch) {
      if (!input.previewPatch) throw new Error('Не указан патч запуска.');
      await this.previewPatch(directory, input.previewPatch);
      const deployment = input.previewPatch.deployment;
      if (deployment?.length) {
        const signal = AbortSignal.timeout(PROJECT_LIMITS.deploymentMs - PROJECT_LIMITS.requestMs);
        const common = (await this.git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
        const operations = new PostOperationRunner(this.executor);
        for (const [index, command] of deployment.entries()) {
          try {
            await operations.run(command, directory, common, signal);
          } catch (cause) {
            const diagnostic = cause instanceof Error ? cause.message : String(cause);
            return { path: directory, deploymentError: `Пост-операция ${index + 1} из ${deployment.length}: ${diagnostic.slice(0, 2000)}` };
          }
        }
      }
      return { path: directory };
    }
    if (input.action === ProjectAction.Diff) {
      const { head, base } = input.diff ?? {};
      const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
      if (!head || !sha.test(head) || (base !== undefined && !sha.test(base))) throw new Error('Некорректный диапазон Git.');
      const args = base ? ['diff', base, head] : ['show', '--format=', head];
      const limit = 32000;
      const text = await this.executor.run({ command: 'git', args: [...args, '--no-ext-diff', '--no-textconv', '--no-color', '--'],
        cwd: directory, signal: AbortSignal.timeout(PROJECT_LIMITS.commandMs), maxOutputChars: limit });
      return { path: directory, diff: { text, truncated: text.length >= limit } };
    }
    if (input.action === ProjectAction.Browse) {
      const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
      const drives = process.platform === 'win32' ? (await Promise.all(Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', async letter => {
        const root = letter + ':/';
        try { return (await stat(root)).isDirectory() ? root : undefined; } catch { return undefined; }
      }))).filter((root): root is string => root !== undefined) : undefined;
      return { path: directory, parent: path.dirname(directory), drives, truncated: entries.length > PROJECT_LIMITS.maxEntries,
        directories: entries.slice(0, PROJECT_LIMITS.maxEntries).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) })) };
    }
    const root = (await this.git(directory, ['rev-parse', '--show-toplevel'])).trim();
    if (input.action === ProjectAction.Research) {
      return { path: root, passport: await researchProject(this.executor, root, input.baseBranch ?? '') };
    }
    if (input.action === ProjectAction.CreateBranch) {
      const branch = input.newBranch ?? ''; const base = input.baseBranch ?? '';
      if (branch.startsWith('-') || base.startsWith('-') || !base || !branch) throw new Error('Некорректное имя ветки.');
      await this.git(root, ['check-ref-format', '--branch', branch]);
      await this.git(root, ['show-ref', '--verify', `refs/heads/${base}`]);
      await this.git(root, ['branch', '--', branch, base]);
    }
    const branches = (await this.git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).trim().split('\n').map((v) => v.trim()).filter(Boolean);
    if (branches.length > PROJECT_LIMITS.maxEntries) throw new Error('Слишком много веток для выбора.');
    let scriptBodies: Record<string, string> = {}; let hasLockfile = false;
    try {
      const file = path.join(root, 'package.json');
      if ((await stat(file)).size <= PROJECT_LIMITS.packageBytes) {
        const json = JSON.parse(await readFile(file, 'utf8')) as { scripts?: Record<string, unknown> };
        scriptBodies = Object.fromEntries(Object.entries(json.scripts ?? {})
          .filter((entry): entry is [string, string] => entry[0].length <= 200 && typeof entry[1] === 'string')
          .slice(0, PROJECT_LIMITS.maxEntries)
          .map(([name, value]) => [name, value.length > 300 ? value.slice(0, 300) + '…' : value]));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Не удалось прочитать package.json проекта.'); }
    try { await stat(path.join(root, 'package-lock.json')); hasLockfile = true; } catch { /* non-npm projects have no lockfile */ }
    return { path: root, branches, currentBranch: (await this.git(root, ['branch', '--show-current'])).trim(), scripts: Object.keys(scriptBodies), scriptBodies, hasLockfile };
  }
  private async previewPatch(cwd: string, patch: PreviewPatch): Promise<void> {
    const git = async (...args: string[]) => (await this.git(cwd, args)).trimEnd();
    const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
    if (!sha.test(patch.head) || !/^[\w-]+$/.test(patch.runId)) throw new Error('Некорректный патч.');
    const file = path.join(await git('rev-parse', '--absolute-git-dir'), 'sat-preview-patch.json');
    const base = await git('rev-parse', 'HEAD');
    const status = await git('status', '--porcelain=v1', '--untracked-files=all');
    if (patch.rollback) {
      let receipt: { runId: string; base: string; tree: string; branch: string };
      try { receipt = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (patch.deployment?.length && (status || await git('branch', '--show-current') !== patch.branch)) {
          throw new Error('Для развёртывания после отката нужна чистая базовая ветка.');
        }
        return; }
      if (receipt.runId !== patch.runId || receipt.base !== base || receipt.branch !== await git('branch', '--show-current')
        || !sha.test(receipt.tree) || status.split('\n').some(line => line && line[1] !== ' ')) {
        throw new Error('Рабочая копия изменилась после примерки. Сохраните правки перед откатом.');
      }
      const index = await git('write-tree');
      if (index === receipt.tree) await git('read-tree', '-m', '-u', receipt.tree, base);
      else if (status) throw new Error('Индекс изменился после примерки. Откат остановлен.');
      await unlink(file);
      return;
    }
    if (status || await git('branch', '--show-current') !== patch.branch) {
      throw new Error('Перед примеркой закоммитьте локальные правки и откройте базовую ветку.');
    }
    const tree = await git('merge-tree', '--write-tree', base, patch.head);
    if (!sha.test(tree)) throw new Error('Не удалось подготовить дерево патча.');
    await writeFile(file, JSON.stringify({ runId: patch.runId, base, tree, branch: patch.branch }), { flag: 'wx' });
    await git('read-tree', '-m', '-u', base, tree);
  }
  private async git(cwd: string, args: string[]): Promise<string> {
    return this.executor.run({ command: 'git', args, cwd, signal: AbortSignal.timeout(PROJECT_LIMITS.commandMs) });
  }
}
