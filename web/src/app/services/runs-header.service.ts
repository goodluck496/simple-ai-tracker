import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { WorkspaceService } from './workspace.service';

export type RunsView = 'queue' | 'history' | 'metrics';

export interface LaneFilterItem {
  id: string;
  label: string;
  count: number;
}

export interface WorkerStatusInfo {
  online: boolean;
  state?: string;
  label: string;
}

@Injectable({ providedIn: 'root' })
export class RunsHeaderService {
  private readonly router = inject(Router);
  private readonly workspace = inject(WorkspaceService);

  public readonly view = signal<RunsView>('history');
  public readonly search = signal<string>('');
  public readonly activeLaneFilter = signal<string>('all');
  public readonly laneFilters = signal<LaneFilterItem[]>([]);
  public readonly workerStatus = signal<WorkerStatusInfo>({
    online: false,
    label: 'Ожидание worker',
  });
  public readonly historyTask = signal<string>('');
  public readonly refreshRequested = new Subject<void>();

  public navigate(view: RunsView): void {
    this.view.set(view);
    void this.router.navigate(['/automation/runs', view], {
      queryParams: { workspace: this.workspace.current() },
    });
  }

  public openSettings(): void {
    void this.router.navigate(['/automation/settings', 'team'], {
      queryParams: { workspace: this.workspace.current() },
    });
  }

  public requestRefresh(): void {
    this.refreshRequested.next();
  }

  public clearSearch(): void {
    this.search.set('');
  }
}
