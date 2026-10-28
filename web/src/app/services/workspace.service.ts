import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { WORKSPACE_STORAGE_KEY } from './workspace.interceptor';

const API_BASE = '/api';

export interface Workspace {
  readonly name: string;
  readonly label: string;
  readonly createdAt: string;
  readonly dbPath: string;
  readonly backupDir: string;
}

export interface WorkspaceListResponse {
  readonly workspaces: readonly Workspace[];
  readonly current: string;
}

/** Сервис управления пространствами задач (workspaces). */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly http = inject(HttpClient);

  private readonly workspacesSignal = signal<readonly Workspace[]>([]);
  private readonly currentSignal = signal(sessionStorage.getItem(WORKSPACE_STORAGE_KEY) ?? 'default');
  private readonly loadingSignal = signal(false);

  public readonly workspaces = this.workspacesSignal.asReadonly();
  public readonly current = this.currentSignal.asReadonly();
  public readonly loading = this.loadingSignal.asReadonly();

  /** Опции для p-select. */
  public readonly options = computed(() =>
    this.workspaces().map((ws) => ({ label: ws.label, value: ws.name })),
  );

  /** Загрузить список пространств. */
  public async load(): Promise<void> {
    this.loadingSignal.set(true);
    try {
      const res = await firstValueFrom(this.http.get<WorkspaceListResponse>(`${API_BASE}/workspaces`));
      if (res) {
        this.workspacesSignal.set(res.workspaces);
        if (!res.workspaces.some((ws) => ws.name === this.current())) {
          sessionStorage.removeItem(WORKSPACE_STORAGE_KEY);
          window.location.reload();
        }
      }
    } finally {
      this.loadingSignal.set(false);
    }
  }

  /** Создать новое пространство. */
  public async create(name: string, label?: string): Promise<void> {
    await firstValueFrom(this.http.post(`${API_BASE}/workspaces`, { name, label }));
    await this.load();
  }

  public async rename(name: string, label: string): Promise<void> {
    await firstValueFrom(this.http.post(`${API_BASE}/workspaces/${encodeURIComponent(name)}/rename`, { label }));
    await this.load();
  }

  /** Переключить активное пространство. */
  public async activate(name: string): Promise<void> {
    await firstValueFrom(this.http.post(`${API_BASE}/workspaces/${encodeURIComponent(name)}/activate`, {}));
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, name);
    this.currentSignal.set(name);
    window.location.reload();
  }

  /** Удалить пространство. */
  public async remove(name: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${API_BASE}/workspaces/${encodeURIComponent(name)}`));
    await this.load();
  }
}
