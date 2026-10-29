import { Injectable, computed, inject, signal } from '@angular/core';
import { ColumnSorting, type ColumnSort } from '../../../../shared/board/column-sort';
import type { TaskStatus } from '../models/tracker.models';
import { WorkspaceService } from './workspace.service';

type Preferences = Partial<Record<TaskStatus, ColumnSort>>;
const STORAGE_PREFIX = 'sat.board.column-sort.v1:';

@Injectable({ providedIn: 'root' })
export class BoardSortService {
  private readonly workspace = inject(WorkspaceService);
  private readonly edits = signal<ReadonlyMap<string, Preferences>>(new Map());
  private readonly saved = computed<Preferences>(() => {
    const key = STORAGE_PREFIX + this.workspace.current();
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([, mode]) => ColumnSorting.valid(mode)));
    } catch { return {}; }
  });
  private readonly preferences = computed(() => this.edits().get(this.workspace.current()) ?? this.saved());
  public mode(status: TaskStatus): ColumnSort { return this.preferences()[status] ?? 'manual'; }
  public set(status: TaskStatus, mode: unknown): void {
    if (!ColumnSorting.valid(mode)) return;
    const workspace = this.workspace.current(), next = { ...this.preferences(), [status]: mode };
    this.edits.update(edits => new Map(edits).set(workspace, next));
    try { localStorage.setItem(STORAGE_PREFIX + workspace, JSON.stringify(next)); }
    catch { /* Keep the selected order for this session when browser storage is unavailable. */ }
  }
}
