import type { CheckCommand, PostOperation } from './contracts.js';
import type { ModelCatalogInput, ModelOption } from './model-catalog.js';

export const ProjectAction = { Browse: 'browse', Inspect: 'inspect', Research: 'research', CreateBranch: 'create-branch', PickFolder: 'pick-folder', Models: 'models', UnloadOllama: 'unload-ollama', Diff: 'diff', PreviewPatch: 'preview-patch', Cleanup: 'cleanup', StartWorker: 'start-worker', StopWorker: 'stop-worker' } as const;
export type ProjectAction = typeof ProjectAction[keyof typeof ProjectAction];
export interface ExecutionStatus { state: 'starting' | 'running' | 'stopping' | 'stopped'; pid?: number; hostName?: string; error?: string; }
export const ProjectRequestStatus = { Queued: 'queued', Running: 'running', Completed: 'completed', Failed: 'failed' } as const;
export type ProjectRequestStatus = typeof ProjectRequestStatus[keyof typeof ProjectRequestStatus];
export const PROJECT_LIMITS = { requestMs: 60000, cleanupMs: 300000, deploymentMs: 300000, commandMs: 15000, pollMs: 1500, maxHistory: 20, maxEntries: 200, packageBytes: 1024 * 1024 } as const;
export interface ProjectInput { action: ProjectAction; path: string; baseBranch?: string; newBranch?: string; catalog?: ModelCatalogInput; model?: string; cleanup?: import('./cleanup.js').CleanupSpec; diff?: { head: string; base?: string }; previewPatch?: PreviewPatch; }
export interface PreviewPatch { runId: string; head: string; branch: string; rollback: boolean; deployment?: PostOperation[]; }
export interface ProjectDiff { text: string; truncated: boolean; }
export interface ProjectPassport {
  path: string;
  branch: string;
  commit: string;
  architecture: string[];
  runtime: string[];
  development: string[];
  skills: string[];
  commands: { source: string; names: string[] }[];
  packageManager?: PackageManager;
  hasLockfile?: boolean;
}
export interface ProjectResult { path: string; passport?: ProjectPassport; cleanup?: import('./cleanup.js').CleanupResult; cancelled?: boolean; parent?: string; drives?: string[]; directories?: { name: string; path: string }[];
  execution?: ExecutionStatus; unloaded?: string; deploymentError?: string; diff?: ProjectDiff;
  branches?: string[]; currentBranch?: string; scripts?: string[]; scriptBodies?: Record<string, string>; packageManager?: PackageManager; hasLockfile?: boolean; truncated?: boolean; models?: ModelOption[]; }
export interface ProjectRequest extends ProjectInput { id: string; status: ProjectRequestStatus; createdAt: number;
  targetWorkerId?: string;
  workerId?: string; token?: string; result?: ProjectResult; error?: string; }
export interface HostStatus { online: boolean; workerId?: string; lastSeen?: number; platform?: string; execution?: ExecutionStatus; executionDesired?: boolean; }
export const WorkerPlatform = { Windows: 'win32', Linux: 'linux', MacOS: 'darwin' } as const;
export interface CommandPreset { id: string; label: string; description: string; value: CheckCommand; }
export type PackageManager = 'npm' | 'pnpm';
export interface PackageManagerInfo { packageManager: PackageManager; hasLockfile: boolean; }
export function detectPackageManager(declared: unknown, pnpmFiles: boolean): PackageManager {
  if (typeof declared === 'string' && /^pnpm(?:@|$)/i.test(declared)) return 'pnpm';
  if (typeof declared === 'string' && /^npm(?:@|$)/i.test(declared)) return 'npm';
  return pnpmFiles ? 'pnpm' : 'npm';
}
export function packageScript(manager: PackageManager, name: string): CheckCommand {
  return { command: manager, args: manager === 'npm' && name === 'test' ? ['test'] : ['run', name] };
}
export function pnpmInstall(hasLockfile: boolean): CheckCommand {
  return { command: 'pnpm', args: ['install', hasLockfile ? '--frozen-lockfile' : '--no-lockfile', '--prod=false'] };
}
export const SETUP_PRESETS: readonly CommandPreset[] = [
  { id: 'npm-ci', label: 'npm ci', description: 'Установить зависимости строго по package-lock.json', value: { command: 'npm', args: ['ci'] } },
  { id: 'npm-install', label: 'npm install', description: 'Установить зависимости без lock-файла', value: { command: 'npm', args: ['install'] } },
];
export const CHECK_PRESETS: readonly CommandPreset[] = [
  { id: 'test', label: 'Тесты', description: 'npm test', value: { command: 'npm', args: ['test'] } },
  { id: 'build', label: 'Сборка', description: 'npm run build', value: { command: 'npm', args: ['run', 'build'] } },
  { id: 'lint', label: 'Линтер', description: 'npm run lint', value: { command: 'npm', args: ['run', 'lint'] } },
  { id: 'typecheck', label: 'Типы', description: 'npm run typecheck', value: { command: 'npm', args: ['run', 'typecheck'] } },
];

/** Translate the npm commands older Tracker presets saved against a pnpm project. */
export function projectCommand<T extends CheckCommand>(command: T, project: PackageManagerInfo): T {
  if (project.packageManager !== 'pnpm' || !/^npm(?:\.cmd|\.exe)?$/i.test((command.command.split(/[\\/]/).at(-1) ?? ''))) return command;
  const [action, ...args] = command.args;
  if (action === 'ci' || action === 'install' || action === 'i') {
    const npmFlags = /^(?:--no-audit|--no-fund|--include=dev|--loglevel=.+)$/;
    const flags = args.filter(arg => !npmFlags.test(arg));
    if (flags.every(arg => ['--ignore-scripts', '--offline', '--prefer-offline', '--no-optional'].includes(arg))) {
      const install = pnpmInstall(project.hasLockfile || action === 'ci');
      return { ...command, ...install, args: [...install.args, ...flags] };
    }
  }
  if ((action === 'run' || action === 'run-script') && args[0] && !args[0].startsWith('-')) {
    return { ...command, command: 'pnpm', args: ['run', args[0], ...args.slice(args[1] === '--' ? 2 : 1)] };
  }
  if (['test', 't', 'tst', 'start', 'stop', 'restart'].includes(action)) {
    const script = ['t', 'tst'].includes(action) ? 'test' : action;
    return { ...command, command: 'pnpm', args: ['run', script, ...args.slice(args[0] === '--' ? 1 : 0)] };
  }
  throw new Error(`Проект использует pnpm. Замените сохранённую команду npm ${action ?? ''} на эквивалентную команду pnpm в настройках проекта.`);
}
