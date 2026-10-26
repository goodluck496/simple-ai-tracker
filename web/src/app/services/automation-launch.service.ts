import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { EMPTY, defer, finalize, map, of, switchMap } from 'rxjs';
import { ACTIVE_RUN_STATUSES, type AgentRun } from '../../../../shared/automation/contracts';
import type { QueueSnapshot } from '../../../../shared/automation/queue';

/** Starts from saved workspace settings; an existing active attempt is opened instead of duplicated. */
@Injectable({ providedIn: 'root' })
export class AutomationLaunchService {
  private readonly http = inject(HttpClient);
  public readonly pending = signal<ReadonlySet<string>>(new Set());
  public start(taskId: string) {
    return defer(() => {
      if (this.pending().has(taskId)) return EMPTY;
      this.pending.update((ids) => new Set([...ids, taskId]));
      return this.http.get<QueueSnapshot>('/api/automation/queue').pipe(
        switchMap(({ items }) => {
          const active = items.find((item) => item.taskId === taskId && ACTIVE_RUN_STATUSES.includes(item.status));
          return active ? of(active.id) : this.http.post<{ run: AgentRun }>('/api/automation/runs', { taskId }).pipe(map(({ run }) => run.id));
        }),
        finalize(() => this.pending.update((ids) => new Set([...ids].filter((id) => id !== taskId)))),
      );
    });
  }
}
