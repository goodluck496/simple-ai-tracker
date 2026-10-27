import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Input, Output, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TokenMeter } from '../../../../../shared/automation/token-usage';
import { RunBudget } from '../../../../../shared/automation/budget';
import { RunConsoleComponent } from '../run-console/run-console.component';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { EMPTY, Subject, catchError, combineLatest, exhaustMap, finalize, merge, of, switchMap, tap, timer } from 'rxjs';
import { AUTOMATION_TIMING, RunStatus, RunAction, type AgentRun, type RunEvent } from '../../../../../shared/automation/contracts';
import { QUEUE_LANES, QUEUE_LIMITS, RUN_EVENT_TITLES, RUN_PHASE_TITLES, RUN_STATUS_TITLES, INTEGRATION_STATE_TITLES, QueuePresentation, RunProgressText,
  type QueueItem, type QueueSnapshot, type QueueLane } from '../../../../../shared/automation/queue';
import { ROLE_OPTIONS } from '../../../../../shared/automation/presets';
import { TASK_STATUS_TITLES } from '../../../../../shared/automation/task-readiness';
import { WorkspaceService } from '../../services/workspace.service';
import { filterQueueItems } from './queue-search';

@Component({ selector: 'sat-automation-queue', standalone: true, imports: [DatePipe, DecimalPipe, RunConsoleComponent, TableModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './automation-queue.component.html', styleUrl: './automation-queue.component.scss' })
export class AutomationQueueComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly workspace = inject(WorkspaceService);
  private readonly refresh = new Subject<void>();
  public readonly selectedId = signal<string | null>(null);
  @Input() public set runId(value: string | null) { this.selectedId.set(value); }
  @Output() public readonly openTask = new EventEmitter<string>();
  @Output() public readonly configure = new EventEmitter<void>();
  @Output() public readonly changed = new EventEmitter<void>();
  public readonly error = signal('');
  public readonly notice = signal('');
  public readonly busy = signal(false);
  public readonly budgetEditing = signal(false);
  public budgetCalls = 6;
  public budgetInput = 500000;
  public budgetMinutes = 20;
  public editBudget(run: AgentRun): void {
    this.budgetCalls = Math.max(run.settings.maxAgentCalls ?? 6, run.budgetApproval?.requiredCalls ?? 0); this.budgetInput = run.settings.maxInputTokens ?? 500000;
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
  public readonly snapshot = toSignal(merge(timer(0, AUTOMATION_TIMING.pollMs), this.refresh).pipe(
    exhaustMap(() => this.http.get<QueueSnapshot>('/api/automation/queue').pipe(
      catchError((error: unknown) => { this.error.set(this.message(error)); return EMPTY; }),
    )),
  ), { initialValue: { items: [], host: { online: false }, serverTime: new Date().toISOString() } as QueueSnapshot });
  public readonly selected = computed(() => this.snapshot().items.find((run) => run.id === this.selectedId()));
  public readonly detail = toSignal(combineLatest([toObservable(this.selectedId), merge(timer(0, AUTOMATION_TIMING.pollMs), this.refresh)]).pipe(
    switchMap(([id]) => id ? this.http.get<{ run: AgentRun; events: RunEvent[] }>(`/api/automation/runs/${id}`).pipe(
      catchError((error: unknown) => { this.error.set(this.message(error)); return of(null); }),
    ) : of(null)),
  ), { initialValue: null });
  public items(lane: QueueLane): QueueItem[] { return filterQueueItems(this.snapshot().items.filter((item) => QueuePresentation.lane(item) === lane), this.search()); }
  public total(lane: QueueLane): number { return this.snapshot().items.filter((item) => QueuePresentation.lane(item) === lane).length; }
  public clearSearch(): void { this.search.set(''); }
  public health(item: QueueItem): string { return QueuePresentation.health(item, Date.parse(this.snapshot().serverTime), this.snapshot().host); }
  public role(role: string): string { return ROLE_OPTIONS.find((entry) => entry.value === role)?.label ?? role; }
  public currentRole(item: QueueItem): string { return item.status === RunStatus.Integrating ? 'Интеграция' : item.phase === 'waiting-slot' ? 'Ожидание слота' : this.role(item.pipeline.at(item.stage)?.role ?? ''); }
  public duration(at: string | undefined): string { return at ? `${Math.max(0, Math.floor((Date.parse(this.snapshot().serverTime) - Date.parse(at)) / 1000))} с` : 'нет данных'; }
  public progress(text: string): string { return RunProgressText.format(text); }
  public select(id: string): void { this.selectedId.set(id); this.error.set(''); }
  constructor() {
    let current = this.workspace.current();
    effect(() => {
      const next = this.workspace.current();
      if (next !== current) { current = next; this.search.set(''); this.selectedId.set(null); this.archived.set(null); }
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
