import type { CheckCommand } from './contracts.js';
import type { ModelCatalogInput, ModelOption } from './model-catalog.js';

export const ProjectAction = { Browse: 'browse', Inspect: 'inspect', CreateBranch: 'create-branch', PickFolder: 'pick-folder', Models: 'models' } as const;
export type ProjectAction = typeof ProjectAction[keyof typeof ProjectAction];
export const ProjectRequestStatus = { Queued: 'queued', Running: 'running', Completed: 'completed', Failed: 'failed' } as const;
export type ProjectRequestStatus = typeof ProjectRequestStatus[keyof typeof ProjectRequestStatus];
export const PROJECT_LIMITS = { requestMs: 60000, commandMs: 15000, pollMs: 1500, maxHistory: 20, maxEntries: 200, packageBytes: 1024 * 1024 } as const;
export interface ProjectInput { action: ProjectAction; path: string; baseBranch?: string; newBranch?: string; catalog?: ModelCatalogInput; }
export interface ProjectResult { path: string; cancelled?: boolean; parent?: string; directories?: { name: string; path: string }[];
  branches?: string[]; currentBranch?: string; scripts?: string[]; hasLockfile?: boolean; truncated?: boolean; models?: ModelOption[]; }
export interface ProjectRequest extends ProjectInput { id: string; status: ProjectRequestStatus; createdAt: number;
  workerId?: string; token?: string; result?: ProjectResult; error?: string; }
export interface HostStatus { online: boolean; workerId?: string; lastSeen?: number; platform?: string; }
export const WorkerPlatform = { Windows: 'win32', Linux: 'linux', MacOS: 'darwin' } as const;
export interface CommandPreset { id: string; label: string; description: string; value: CheckCommand; }
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
