import { SKILL_LIMITS } from '../../../../../shared/automation/skills';

export interface SkillFile { path: string; url: string; }

async function download(url: string, maxBytes: number, accept: string): Promise<string> {
  const response = await fetch(url, {credentials:'omit', referrerPolicy:'no-referrer', headers:{Accept:accept}, signal:AbortSignal.timeout(20000)});
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
    const tree = JSON.parse(await download(base + '/git/trees/' + (ref ?? 'HEAD') + '?recursive=1', 8_000_000, 'application/vnd.github+json'));
    if (tree.truncated) throw new Error('GitHub сократил дерево. Вставьте прямую ссылку на нужный SKILL.md.');
    const prefix = tail.length ? decodeURIComponent(tail.join('/')) + '/' : '';
    return tree.tree.filter((entry: {path:string; type:string; mode:string}) =>
      entry.type === 'blob' && /^100(644|755)$/.test(entry.mode) && entry.path.startsWith(prefix) && /(^|\/)SKILL\.md$/i.test(entry.path))
      .map((entry: {path:string; sha:string}) => ({path:entry.path,url:base + '/git/blobs/' + entry.sha}));
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
