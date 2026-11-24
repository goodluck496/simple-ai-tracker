import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pollMs = 2000;

/** A managed default host discovers additions to the same local or bind-mounted registry. */
export function watchWorkspaceRegistry(signal: AbortSignal): void {
  const config = process.env.SAT_WORKSPACE_DISCOVERY;
  if (!config) return;
  const { knownWorkspaces, registry, container } = JSON.parse(config) as { knownWorkspaces: string[]; registry: string; container?: string };
  const known = new Set(knownWorkspaces);
  const mode = container ? ['--docker', '--container', container] : ['--local'];
  let polling = false;

  const timer = setInterval(async () => {
    if (polling || signal.aborted) return;
    polling = true;
    try {
      const { workspaces } = JSON.parse(await readFile(registry, 'utf8')) as { workspaces: { name: string }[] };
      const names = new Set(workspaces.map(workspace => workspace.name));
      for (const name of known) if (!names.has(name)) known.delete(name);
      for (const name of names) {
        if (known.has(name) || !/^[a-z\d][a-z\d_-]{0,49}$/i.test(name)) continue;
        try {
          signal.throwIfAborted();
          await run(process.execPath, ['scripts/worker-service.mjs', 'start', '--workspace', name, '--discovered-workspace', ...mode], { windowsHide: true, signal });
          known.add(name);
        } catch (error) {
          if (!signal.aborted) process.stderr.write(`Workspace ${name}: ${String(error)}\n`);
        }
      }
    } catch (error) {
      if (!signal.aborted) process.stderr.write(`Workspace registry: ${String(error)}\n`);
    } finally { polling = false; }
  }, pollMs);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}
