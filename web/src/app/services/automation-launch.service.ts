import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { EMPTY, defer, finalize, map } from 'rxjs';
import { ACTIVE_RUN_STATUSES } from '../../../../shared/automation/contracts';
import type { QueueSnapshot } from '../../../../shared/automation/queue';

/** Opens an active attempt or a launch preview; never enqueues from the card. */
@Injectable({ providedIn: 'root' })
export class AutomationLaunchService {
  private readonly http = inject(HttpClient);
  public readonly pending = signal<ReadonlySet<string>>(new Set());
  public preview(taskId: string) {
    return defer(() => {
      if (this.pending().has(taskId)) return EMPTY;
      this.pending.update((ids) => new Set([...ids, taskId]));
      return this.http.get<QueueSnapshot>('/api/automation/queue').pipe(
        map(({ items }) => {
          const active = items.find((item) => item.taskId === taskId && ACTIVE_RUN_STATUSES.includes(item.status));
          return active?.id ?? null;
        }),
        finalize(() => this.pending.update((ids) => new Set([...ids].filter((id) => id !== taskId)))),
      );
    });
  }
}
