import { randomUUID } from 'node:crypto';
import type { MetaRepository } from '../domain/ports.js';
import type { SqlDatabase } from '../db/sql-database.js';
import { TrackerError } from '../core/errors.js';
import { DEFAULT_AUTOMATION_SETTINGS, RUNNER_IDS, RunnerId, ProviderKind } from '../../../shared/automation/contracts.js';
import { AutomationSettingsValidator } from './settings.js';
import { ProjectAction, ProjectRequestStatus, PROJECT_LIMITS, type HostStatus, type ProjectInput, type ProjectRequest, type ProjectResult } from '../../../shared/automation/project.js';

const STATE_KEY = 'automation_host_requests_v1';
interface HostState { workerId?: string; lastSeen?: number; platform?: string; requests: ProjectRequest[]; }
/** Workspace-scoped mailbox: only the host worker touches its filesystem. */
export class ProjectRequests {
  public constructor(private readonly meta: MetaRepository, private readonly db: SqlDatabase, private readonly now: () => number = Date.now) {}
  public status(): HostStatus { const state = this.read(); return { online: !!state.lastSeen && this.now() - state.lastSeen < PROJECT_LIMITS.requestMs, workerId: state.workerId, lastSeen: state.lastSeen, platform: state.platform }; }
  public enqueue(input: ProjectInput): ProjectRequest {
    if (!input || !Object.values(ProjectAction).includes(input.action) || typeof input.path !== 'string' || input.path.length > 4096) throw new TrackerError('VALIDATION_FAILED', 'Некорректный запрос проекта.');
    if (input.action === ProjectAction.CreateBranch && (!input.baseBranch || !input.newBranch || input.baseBranch.length > 250 || input.newBranch.length > 250)) throw new TrackerError('VALIDATION_FAILED', 'Укажите исходную и новую ветки.');
    let catalog: ProjectInput['catalog'];
    if (input.action === ProjectAction.Models) {
      if (!input.catalog || !RUNNER_IDS.includes(input.catalog.runner)) throw new TrackerError('VALIDATION_FAILED', 'Укажите исполнитель и подключение моделей.');
      const connection = new AutomationSettingsValidator().validate({ ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), connections: [input.catalog.connection] }).connections[0];
      if ((connection.kind === ProviderKind.Native) === (input.catalog.runner === RunnerId.ModelApi)) throw new TrackerError('VALIDATION_FAILED', 'Исполнитель не соответствует типу подключения.');
      catalog = { runner: input.catalog.runner, connection };
    }
    return this.db.transaction(() => {
      const state = this.read();
      if (state.requests.some((r) => r.status === ProjectRequestStatus.Queued || r.status === ProjectRequestStatus.Running)) throw new TrackerError('CONFLICT', 'Предыдущий запрос к worker ещё выполняется.');
      const request: ProjectRequest = { action: input.action, path: input.path, baseBranch: input.baseBranch, newBranch: input.newBranch, catalog,
        id: randomUUID(), status: ProjectRequestStatus.Queued, createdAt: this.now() };
      state.requests = [...state.requests.slice(-(PROJECT_LIMITS.maxHistory - 1)), request]; this.save(state); return request;
    });
  }
  public get(id: string): ProjectRequest { const request = this.read().requests.find((r) => r.id === id); if (!request) throw new TrackerError('VALIDATION_FAILED', 'Запрос проекта не найден.'); return this.public(request); }
  public poll(workerId: string, platform?: string): ProjectRequest | null {
    return this.db.transaction(() => {
      const state = this.read(); state.workerId = workerId; state.lastSeen = this.now(); state.platform = platform;
      const request = state.requests.find((r) => r.status === ProjectRequestStatus.Queued);
      if (request) { request.status = ProjectRequestStatus.Running; request.workerId = workerId; request.token = randomUUID(); }
      this.save(state); return request ?? null;
    });
  }
  public complete(id: string, token: string, result?: ProjectResult, error?: string): void {
    this.db.transaction(() => {
      const state = this.read(); const request = state.requests.find((r) => r.id === id);
      if (!request || request.status !== ProjectRequestStatus.Running || request.token !== token) throw new TrackerError('CONFLICT', 'Запрос истёк или принадлежит другому worker.');
      if (JSON.stringify(result ?? {}).length > 256000) throw new TrackerError('VALIDATION_FAILED', 'Результат проекта слишком большой.');
      request.status = error ? ProjectRequestStatus.Failed : ProjectRequestStatus.Completed;
      request.result = result; request.error = error?.slice(0, 4000); delete request.token; this.save(state);
    });
  }
  private public(request: ProjectRequest): ProjectRequest { const { token: _token, ...value } = request; return value; }
  private read(): HostState {
    const state: HostState = JSON.parse(this.meta.get(STATE_KEY) ?? '{"requests":[]}');
    for (const request of state.requests) if ((request.status === ProjectRequestStatus.Queued || request.status === ProjectRequestStatus.Running) && this.now() - request.createdAt > PROJECT_LIMITS.requestMs) {
      request.status = ProjectRequestStatus.Failed; request.error = 'Worker не ответил за минуту. Проверьте, что он запущен для этого пространства, и повторите запрос.'; delete request.token;
    }
    return state;
  }
  private save(state: HostState): void { this.meta.set(STATE_KEY, JSON.stringify(state)); }
}
