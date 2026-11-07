import { AGENT_VERDICTS } from '../../../../shared/automation/contracts.js';

/** OpenCode can emit commentary and several text parts in one run. */
export function openCodeOutcome(text: string): string {
  let latest: string | undefined;
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        const candidate = text.slice(start, end + 1);
        try {
          const value = JSON.parse(candidate);
          if (AGENT_VERDICTS.includes(value.verdict) && typeof value.summary === 'string') latest = candidate;
          start = end;
        } catch { /* Continue looking for a complete outcome. */ }
        break;
      }
    }
  }
  return latest ?? text;
}
