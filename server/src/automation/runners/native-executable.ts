import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Installed CLI entry points; does not change PATH or account configuration. */
export class NativeExecutable {
  public static codegraphMcp(cwd: string, environment: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
    const args = ['serve', '--mcp', '--path', cwd, '--no-watch'];
    if (process.platform === 'win32') {
      for (const directory of (environment.PATH ?? environment.Path ?? '').split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue;
        const manifest = path.join(directory, 'node_modules', '@colbymchenry', 'codegraph', 'package.json');
        if (!fs.existsSync(manifest)) continue;
        // npm's spawnSync shim can initialize stdio yet lose subsequent requests.
        // Use the same installed bundle directly, without changing global config.
        const installed = createRequire(manifest);
        const root = path.dirname(installed.resolve(`@colbymchenry/codegraph-win32-${process.arch}/package.json`));
        const command = path.join(root, 'node.exe'); const entry = path.join(root, 'lib', 'dist', 'bin', 'codegraph.js');
        if (!fs.existsSync(command) || !fs.existsSync(entry)) throw new Error('CodeGraph platform bundle is incomplete; reinstall CodeGraph before running agents.');
        return { command, args: ['--liftoff-only', entry, ...args] };
      }
    }
    return { command: 'codegraph', args };
  }
  public static antigravity(environment: NodeJS.ProcessEnv = process.env): string {
    const explicit = environment.SAT_ANTIGRAVITY_PATH;
    if (explicit) {
      if (!path.isAbsolute(explicit) || !fs.statSync(explicit, { throwIfNoEntry: false })?.isFile()) throw new Error('SAT_ANTIGRAVITY_PATH must point to an installed CLI executable.');
      return explicit;
    }
    if (environment.LOCALAPPDATA) {
      const installed = path.join(environment.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
      if (fs.statSync(installed, { throwIfNoEntry: false })?.isFile()) return installed;
    }
    return 'agy';
  }
}
