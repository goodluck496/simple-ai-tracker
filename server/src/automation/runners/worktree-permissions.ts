import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentJob } from '../../../../shared/automation/contracts.js';
import { ProcessExecutor } from './process-executor.js';
import { TaskEnvironment } from './task-environment.js';

/** YOLO is an invocation policy, permitted only in a registered linked checkout. */
export class WorktreePermissions {
  public constructor(private readonly executor = new ProcessExecutor()) {}
  public async verify(job: AgentJob): Promise<void> {
    const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    const root = await fs.realpath(job.settings.repositoryPath);
    const cwd = await fs.realpath(job.cwd);
    if (same(root, cwd)) throw new Error('Antigravity YOLO запрещён в основном checkout. Запустите задачу в отдельной worktree.');
    const marker = await fs.lstat(path.join(cwd, '.git'));
    if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Antigravity YOLO требует linked worktree с отдельным .git файлом.');
    const git = (args: string[], directory = cwd) => this.executor.run({ command: 'git', args, cwd: directory, env: TaskEnvironment.create(), signal: job.signal });
    const top = await fs.realpath((await git(['rev-parse', '--show-toplevel'])).trim());
    const configuredTop = await fs.realpath((await git(['rev-parse', '--show-toplevel'], root)).trim());
    if (!same(top, cwd) || !same(configuredTop, root)) throw new Error('Antigravity YOLO требует корень worktree и корень настроенного репозитория.');
    const common = await fs.realpath(path.resolve(cwd, (await git(['rev-parse', '--git-common-dir'])).trim()));
    const expected = await fs.realpath(path.resolve(root, (await git(['rev-parse', '--git-common-dir'], root)).trim()));
    const directory = await fs.realpath(path.resolve(cwd, (await git(['rev-parse', '--git-dir'])).trim()));
    if (!same(common, expected) || same(directory, common)) throw new Error('Antigravity YOLO: worktree относится к другому репозиторию или не изолирована.');
    const registered = (await git(['worktree', 'list', '--porcelain', '-z'], root)).split('\0')
      .filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice(9)));
    if (!registered.some(entry => same(entry, cwd))) throw new Error('Antigravity YOLO: worktree не зарегистрирована в настроенном репозитории.');
  }
}
