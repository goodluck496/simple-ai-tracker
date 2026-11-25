import { SKILL_LIMITS } from '../../../../../shared/automation/skills';

export interface SkillFile { path: string; url: string; }

class GitHubRateLimitError extends Error {}

async function download(url: string, maxBytes: number, accept: string): Promise<string> {
  const response = await fetch(url, {credentials:'omit', referrerPolicy:'no-referrer', headers:{Accept:accept}, signal:AbortSignal.timeout(20000)});
  if (new URL(url).hostname === 'api.github.com' && (response.status === 429 ||
      (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))))) {
    throw new GitHubRateLimitError('Исчерпан лимит запросов к GitHub API.');
  }
  if (!response.ok || !response.body) throw new Error('Источник вернул HTTP ' + response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let size = 0, result = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return result + decoder.decode();
      size += value.length;
      if (size > maxBytes) throw new Error('Файл превышает допустимый размер.');
      result += decoder.decode(value, {stream:true});
    }
  } finally { await reader.cancel(); }
}

/** All remote reads originate in the importing browser, independently of the worker. */
export async function skillFiles(source: string): Promise<SkillFile[]> {
  const url = new URL(source.trim());
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Укажите публичную HTTPS-ссылку.');
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...tail] = parts;
    if (!owner || !repo || (kind && !['blob','tree'].includes(kind))) throw new Error('Укажите репозиторий GitHub или ссылку на SKILL.md.');
    if (kind === 'blob') return [{path:tail.join('/'),url:`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${tail.join('/')}`}];
    const base = `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/,'')}`;
    const revision = ref ?? 'HEAD';
    let entries: {path:string}[];
    try {
      const tree = JSON.parse(await download(base + '/git/trees/' + revision + '?recursive=1', 8_000_000, 'application/vnd.github+json'));
      if (tree.truncated) throw new Error('GitHub сократил дерево. Вставьте прямую ссылку на нужный SKILL.md.');
      entries = tree.tree.filter((entry: {type:string; mode:string}) => entry.type === 'blob' && /^100(644|755)$/.test(entry.mode));
    } catch (error) {
      if (!(error instanceof GitHubRateLimitError)) throw error;
      const indexUrl = `https://data.jsdelivr.com/v1/package/gh/${owner}/${repo.replace(/\.git$/, '')}@${revision}/flat`;
      const index = JSON.parse(await download(indexUrl, 8_000_000, 'application/json'));
      entries = index.files.map((entry: {name:string}) => ({path:entry.name.replace(/^\//, '')}));
    }
    const prefix = tail.length ? decodeURIComponent(tail.join('/')) + '/' : '';
    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/${revision}/`;
    return entries.filter(({path}) => path.startsWith(prefix) && /(^|\/)SKILL\.md$/i.test(path))
      .map(({path}) => ({path, url:rawBase + path.split('/').map(encodeURIComponent).join('/')}));
  }
  return [{path:decodeURIComponent(url.pathname),url:url.href}];
}

export async function importSkillFile(file: SkillFile) {
  const content = await download(file.url, SKILL_LIMITS.content * 4 + 3, new URL(file.url).hostname === 'api.github.com' ? 'application/vnd.github.raw+json' : 'text/plain, text/markdown');
  if (content.length > SKILL_LIMITS.content || !content.trim() || /^\s*(?:<!doctype html|<html)/i.test(content)) {
    throw new Error(`Нужен текст Markdown длиной до ${SKILL_LIMITS.content} символов.`);
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? '';
  const field = (name: string) => {
    const match = new RegExp('^' + name + ':[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)', 'm').exec(frontmatter);
    return (match?.[1] ?? '').replace(/^[>|][-+]?\s*/, '').trim().replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\s+/g, ' ');
  };
  const name = field('name') || file.path.split('/').at(-2) || 'Навык';
  return { id:'', version:0, name: name.slice(0, SKILL_LIMITS.name),
    description:field('description').slice(0, SKILL_LIMITS.description), content, sourceUrl:file.url };
}
