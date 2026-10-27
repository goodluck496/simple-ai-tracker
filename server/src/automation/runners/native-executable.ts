import fs from 'node:fs';
import path from 'node:path';

/** Installed CLI entry points; does not change PATH or account configuration. */
export class NativeExecutable {
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
