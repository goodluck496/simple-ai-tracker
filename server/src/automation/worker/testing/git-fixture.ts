import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProcessExecutor } from '../../runners/process-executor.js';
import type { IntegrationJob } from '../squash-integration.js';

export async function gitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sat-integration-'));
  const repository = path.join(root, 'repo'); await mkdir(repository);
  const executor = new ProcessExecutor(); const signal = AbortSignal.timeout(90000);
  const git = (args: string[], cwd = repository) => executor.run({ command: 'git', args, cwd, signal });
  await git(['init', '-b', 'master']); await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']); await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repository, 'a.txt'), '0\n'); await writeFile(path.join(repository, 'b.txt'), '0\n');
  await git(['add', '.']); await git(['commit', '-m', 'fixture base']);
  const base = (await git(['rev-parse', 'HEAD'])).trim(); const common = path.join(repository, '.git');
  const branch = async (id: string, file: string, values: string[]) => {
    const cwd = path.join(root, id); await git(['worktree', 'add', '-b', id, cwd, base]);
    for (const value of values) { await writeFile(path.join(cwd, file), value); await git(['add', '.'], cwd); await git(['commit', '-m', 'fixture source'], cwd); }
    const sourceSha = (await git(['rev-parse', 'HEAD'], cwd)).trim();
    const taskId = `SAT-${id.replace(/\D/g, '')}`;
    const job: IntegrationJob = { runId: id, taskId, repository, common, sourceSha, targetBranch: 'master', directory: cwd,
      message: `[#${taskId}] - Изменён ответ задачи, чтобы проверить совместное поведение`, contextKey: id, maxAttempts: 2, signal,
      authorize: async () => {}, record: async () => {}, prepare: async () => {}, checks: async () => {},
      resolve: async () => { throw new Error('Unexpected conflict'); } };
    return { cwd, sourceSha, job };
  };
  return { root, repository, common, git, branch, executor, signal, dispose: () => rm(root, { recursive: true, force: true }) };
}
