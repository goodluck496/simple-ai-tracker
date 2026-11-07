import { PROJECT_LIMITS, type ProjectPassport } from '../../../../shared/automation/project.js';
import { ProcessExecutor } from '../runners/process-executor.js';

export async function researchProject(executor: ProcessExecutor, cwd: string, branch: string): Promise<ProjectPassport> {
  if (!branch || branch.length > 250) throw new Error('Укажите базовую ветку.');
  const signal = AbortSignal.timeout(PROJECT_LIMITS.commandMs);
  const git = (args: string[], maxOutputChars = 1000000) =>
    executor.run({ command: 'git', args, cwd, signal, maxOutputChars });
  const commit = (await git(['show-ref', '--hash', '--verify', 'refs/heads/' + branch])).trim();
  const limit = 1000000;
  const tree = await git(['ls-tree', '-rlz', '--full-tree', commit], limit);
  if (tree.length >= limit) throw new Error('Дерево проекта превышает лимит исследования.');
  const files = new Map<string, { oid: string; size: number }>();
  for (const record of tree.split('\0')) {
    const entry = /^100(?:644|755) blob ([a-f0-9]+) +([0-9]+)\t(.+)$/s.exec(record);
    if (entry) files.set(entry[3], { oid: entry[1], size: Number(entry[2]) });
  }
  const sources = [...files.keys()];
  const section = (pattern: RegExp) => sources.filter(file => file.length <= 300 && pattern.test(file))
    .sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 24);
  const manifests = section(/(?:^|\/)package\.json$/i).slice(0, 12);
  const commands = [];
  for (const source of manifests) {
    const file = files.get(source)!;
    if (file.size > PROJECT_LIMITS.packageBytes) continue;
    const contents = await git(['cat-file', 'blob', file.oid], PROJECT_LIMITS.packageBytes);
    try {
      const scripts: unknown = JSON.parse(contents)?.scripts;
      if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) continue;
      const names = Object.entries(scripts).filter(([name, value]) => /^[\w:.-]{1,80}$/.test(name) && typeof value === 'string')
        .map(([name]) => name).slice(0, 32);
      if (names.length) commands.push({ source, names });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return {
    path: cwd, branch, commit,
    architecture: section(/(?:^|\/)(?:readme[^/]*\.md|architecture[^/]*\.md|adr\/[^/]+\.md|(?:main|index|app|server)\.(?:ts|js|py|go|rs|java|cs|kt|rb|php))$/i),
    runtime: section(/(?:^|\/)(?:dockerfile[^/]*|(?:docker-)?compose[^/]*\.ya?ml|launch\.json|makefile|justfile|procfile)$/i),
    development: section(/(?:^|\/)(?:agents\.md|agent_instructions\.md|claude\.md|contributing[^/]*\.md|agent-environment\.json|\.github\/workflows\/[^/]+|\.gitlab-ci\.yml|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$/i),
    skills: section(/(?:^|\/)skill\.md$/i),
    commands,
  };
}
