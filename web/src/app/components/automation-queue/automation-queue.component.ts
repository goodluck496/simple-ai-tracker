import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Input, Output, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { TokenMeter } from '../../../../../shared/automation/token-usage';
import { RunBudget } from '../../../../../shared/automation/budget';
import { RunConsoleComponent } from '../run-console/run-console.component';
import { RunActivityComponent } from './run-activity.component';
import { ACTIVITY_TIMING } from '../../../../../shared/automation/queue-activity';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { EMPTY, Subject, catchError, combineLatest, exhaustMap, finalize, map, merge, of, switchMap, tap, timer } from 'rxjs';
import { AUTOMATION_TIMING, RunStatus, RunAction, type AgentRun, type RunEvent } from '../../../../../shared/automation/contracts';
import { QUEUE_LANES, QUEUE_LIMITS, RUN_EVENT_TITLES, RUN_PHASE_TITLES, RUN_STATUS_TITLES, INTEGRATION_STATE_TITLES, QueuePresentation, RunProgressText,
  type QueueItem, type QueueSnapshot, type QueueLane } from '../../../../../shared/automation/queue';
import { ROLE_OPTIONS } from '../../../../../shared/automation/presets';
import { TASK_STATUS_TITLES } from '../../../../../shared/automation/task-readiness';
import { WorkspaceService } from '../../services/workspace.service';
import { filterQueueItems } from './queue-search';
import { formatQueueDate, sortRunHistory } from './queue-dates';

@Component({ selector: 'sat-automation-queue', standalone: true, imports: [DatePipe, DecimalPipe, RunConsoleComponent, RunActivityComponent, TableModule, ButtonModule, FormsModule, CheckboxModule],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './automation-queue.component.html', styleUrl: './automation-queue.component.scss' })
export class AutomationQueueComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly workspace = inject(WorkspaceService);
  private readonly refresh = new Subject<void>();
  public readonly selectedId = signal<string | null>(null);
  @Input() public set runId(value: string | null) { this.selectedId.set(value); if (value) this.historyMode.set(true); }
  public readonly historyMode = signal(false);
  public readonly historyTask = signal('');
  public readonly showDetails = signal(false);
  public readonly leftSidebarOpen = signal(true);
  public readonly activeLaneFilter = signal<string>('all');
  public readonly confirmation = signal<'cleanup' | 'delete' | null>(null);
  public discard = false;
  private readonly selectedCache = signal<QueueItem | undefined>(undefined);
  @Output() public readonly openTask = new EventEmitter<string>();
  @Output() public readonly configure = new EventEmitter<void>();
  @Output() public readonly changed = new EventEmitter<void>();
  public readonly error = signal('');
  public readonly pollError = signal('');
  public readonly queueConnected = signal(false);
  private readonly receivedAt = signal(performance.now());
  private readonly clock = toSignal(timer(0, ACTIVITY_TIMING.tickMs).pipe(map(() => performance.now())), { initialValue: performance.now() });
  public readonly dataFresh = computed(() => this.queueConnected() && this.clock() - this.receivedAt() < ACTIVITY_TIMING.snapshotMs);
  public readonly notice = signal('');
  public readonly busy = signal(false);
  public readonly budgetEditing = signal(false);
  public budgetCalls = 6;
  public budgetInput = 500000;
  public budgetMinutes = 20;
  public editBudget(run: AgentRun): void {
    this.budgetCalls = run.settings.maxAgentCalls ?? 6; this.budgetInput = run.settings.maxInputTokens ?? 500000;
    this.budgetMinutes = run.settings.maxRunMinutes ?? 20; this.budgetEditing.set(true);
  }
  public saveBudget(run: AgentRun): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.http.post(`/api/automation/runs/${run.id}/budget`, { maxAgentCalls: this.budgetCalls, maxInputTokens: this.budgetInput, maxRunMinutes: this.budgetMinutes })
      .pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.budgetEditing.set(false); this.refresh.next(); this.notice.set('Лимиты сохранены. Потраченный бюджет учтён; нажмите «Продолжить с места остановки».'); },
        error: (error: unknown) => this.error.set(this.message(error)),
      });
  }
  public readonly search = signal('');
  public readonly statusTitles = RUN_STATUS_TITLES;
  public readonly taskTitles = TASK_STATUS_TITLES;
  public readonly phaseTitles = RUN_PHASE_TITLES;
  public readonly integrationTitles = INTEGRATION_STATE_TITLES;
  public readonly lanes = QUEUE_LANES;
  public readonly recentLimit = QUEUE_LIMITS.recent;
  public readonly archived = signal<AgentRun[] | null>(null);
  public readonly eventTitles = RUN_EVENT_TITLES;
  public readonly runStatus = RunStatus;
  public readonly runAction = RunAction;
  public readonly tokenMeter = TokenMeter;
  public readonly runBudget = RunBudget;
  public readonly snapshot = toSignal(combineLatest([toObservable(this.historyMode), toObservable(this.historyTask), merge(timer(0, AUTOMATION_TIMING.pollMs), this.refresh)]).pipe(
    switchMap(([history, task]) => this.http.get<QueueSnapshot>(history ? `/api/automation/history${task ? '?taskId=' + encodeURIComponent(task) : ''}` : '/api/automation/queue').pipe(
      tap(() => { this.receivedAt.set(performance.now()); this.queueConnected.set(true); this.pollError.set(''); }),
      catchError((error: unknown) => { this.queueConnected.set(false); this.pollError.set(this.message(error)); return EMPTY; }),
    )),
  ), { initialValue: { items: [], host: { online: false }, serverTime: new Date().toISOString() } as QueueSnapshot });
  public readonly now = computed(() => Date.parse(this.snapshot().serverTime) + Math.max(0, this.clock() - this.receivedAt()));
  public readonly selected = computed(() => {
    const id = this.selectedId();
    const snapshot = this.snapshot().items.find(run => run.id === id);
    const detail = this.detail()?.item;
    if (detail?.id === id && (!snapshot || detail.updatedAt >= snapshot.updatedAt)) return detail;
    return snapshot ?? (this.selectedCache()?.id === id ? this.selectedCache() : undefined);
  });
  public readonly detail = toSignal(combineLatest([toObservable(this.selectedId), merge(timer(0, AUTOMATION_TIMING.pollMs), this.refresh)]).pipe(
    switchMap(([id]) => id ? this.http.get<{ run: AgentRun; item?: QueueItem; events: RunEvent[] }>(`/api/automation/runs/${id}`).pipe(
      catchError((error: unknown) => { this.error.set(this.message(error)); return of(null); }),
    ) : of(null)),
  ), { initialValue: null });
  public items(lane: QueueLane): QueueItem[] {
    const items = this.snapshot().items.filter(item => QueuePresentation.lane(item) === lane);
    return filterQueueItems(this.historyMode() ? sortRunHistory(items) : items, this.search());
  }
  public archivedItems(): AgentRun[] { return sortRunHistory(this.archived() ?? []); }
  public timestamp(value: string | undefined): string { return formatQueueDate(value); }
  public total(lane: QueueLane): number { return this.snapshot().items.filter((item) => QueuePresentation.lane(item) === lane).length; }
  public clearSearch(): void { this.search.set(''); }
  public resumeBudgetBlocked(item: QueueItem): boolean {
    const run = this.detail()?.run;
    return !!run && run.id === item.id && !!RunBudget.reason(run, this.now(), run.stage < run.settings.pipeline.length);
  }
  public health(item: QueueItem): string { return QueuePresentation.health(item, this.now(), this.snapshot().host); }
  public role(role: string): string { return ROLE_OPTIONS.find((entry) => entry.value === role)?.label ?? role; }
  public currentRole(item: QueueItem): string { return item.status === RunStatus.Integrating ? 'Интеграция' : item.phase === 'waiting-slot' ? 'Ожидание слота' : this.role(item.pipeline.at(item.stage)?.role ?? ''); }
  public duration(at: string | undefined): string { return at ? `${Math.max(0, Math.floor((this.now() - Date.parse(at)) / 1000))} с` : 'нет данных'; }
  public progress(text: string): string { return RunProgressText.format(text); }
  public select(id: string): void { this.selectedCache.set(this.snapshot().items.find(run => run.id === id)); this.selectedId.set(id); this.error.set(''); this.confirmation.set(null); }
  public toggleLeftSidebar(): void { this.leftSidebarOpen.update(v => !v); }
  public switchMode(history: boolean): void { this.historyMode.set(history); if (!history) this.historyTask.set(''); this.activeLaneFilter.set('all'); }
  public filteredLanes() { return this.activeLaneFilter() === 'all' ? this.visibleLanes() : this.visibleLanes().filter(lane => lane.id === this.activeLaneFilter()); }
  public totalActive(): number { return this.items('queued').length + this.items('running').length; }
  public viewHistory(taskId = ''): void { this.historyTask.set(taskId); this.historyMode.set(true); this.refresh.next(); }
  public visibleLanes() { return this.historyMode() ? this.lanes : this.lanes.filter(lane => lane.id === 'queued' || lane.id === 'running'); }
  public manage(item: QueueItem): boolean { return !['queued', 'running', 'integrating', 'waiting'].includes(item.status); }
  public requestConfirmation(action: 'cleanup' | 'delete'): void { this.confirmation.set(action); this.discard = false; }
  public confirm(item: QueueItem): void {
    const action = this.confirmation(); if (!action || this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.http.post(`/api/automation/runs/${item.id}/${action}`, { discard: this.discard }).pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.confirmation.set(null); if (action === 'delete') { this.selectedId.set(null); this.selectedCache.set(undefined); } this.refresh.next(); this.changed.emit(); },
      error: (error: unknown) => this.error.set(this.message(error)),
    });
  }
  constructor() {
    let current = this.workspace.current();
    effect(() => {
      const next = this.workspace.current();
      if (next !== current) { current = next; this.search.set(''); this.selectedId.set(null); this.selectedCache.set(undefined); this.archived.set(null); this.historyTask.set(''); this.historyMode.set(false); }
    });
    effect(() => {
      const run = this.detail()?.run;
      if (run && run.id === this.selectedId() && !['queued', 'running', 'integrating'].includes(run.status)) this.historyMode.set(true);
    });
    effect(() => {
      const items = this.snapshot().items;
      if (!this.selectedId() && items.length > 0) {
        const running = items.find(i => i.status === RunStatus.Running || i.status === RunStatus.Integrating) ?? items[0];
        if (running) {
          this.selectedId.set(running.id);
          this.selectedCache.set(running);
        }
      }
    });
  }
  public action(item: QueueItem, action: RunAction): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    this.http.post<{ run?: AgentRun }>(`/api/automation/runs/${item.id}/${action}`, {}).pipe(
      tap((result) => { if (result.run) this.selectedId.set(result.run.id); this.refresh.next(); this.changed.emit(); }),
      catchError((error: unknown) => { this.error.set(this.message(error)); return EMPTY; }),
      finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }
  public dequeue(item: QueueItem): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    this.http.post('/api/automation/runs/' + item.id + '/dequeue', {}).pipe(
      tap(() => { this.notice.set('Убрано из очереди. Задача и журнал сохранены.'); this.refresh.next(); this.changed.emit(); }),
      catchError((error: unknown) => { this.error.set(this.message(error)); this.refresh.next(); return EMPTY; }),
      finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }
  private message(error: unknown): string {
    const value = error as { error?: { error?: { message?: string } }; message?: string };
    return value.error?.error?.message ?? value.message ?? 'Не удалось обновить очередь.';
  }
  public openArchive(): void {
    if (this.archived() !== null) { this.archived.set(null); return; }
    this.http.get<{ runs: AgentRun[] }>('/api/automation/runs/archive').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ runs }) => { this.archived.set(runs); this.error.set(''); }, error: (error: unknown) => this.error.set(this.message(error)),
    });
  }
  public restore(id: string): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.http.post('/api/automation/runs/' + id + '/restore', {}).pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.archived.set((this.archived() ?? []).filter((run) => run.id !== id)); this.refresh.next(); this.changed.emit(); },
      error: (error: unknown) => this.error.set(this.message(error)),
    });
  }
  public hide(item: QueueItem): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.http.post('/api/automation/runs/' + item.id + '/hide', {}).pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.refresh.next(); if (this.selectedId() === item.id) this.selectedId.set(null); this.changed.emit(); },
      error: (error: unknown) => { this.error.set(this.message(error)); this.refresh.next(); },
    });
  }
}
