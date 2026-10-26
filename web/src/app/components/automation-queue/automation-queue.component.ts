import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TokenMeter } from '../../../../../shared/automation/token-usage';
import { AccordionModule } from 'primeng/accordion';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { EMPTY, Subject, catchError, combineLatest, exhaustMap, finalize, merge, of, switchMap, tap, timer } from 'rxjs';
import { AUTOMATION_TIMING, RunStatus, RunAction, type AgentRun, type RunEvent } from '../../../../../shared/automation/contracts';
import { QUEUE_LANES, QUEUE_LIMITS, RUN_EVENT_TITLES, RUN_PHASE_TITLES, RUN_STATUS_TITLES, QueuePresentation, RunProgressText,
  type QueueItem, type QueueSnapshot, type QueueLane } from '../../../../../shared/automation/queue';
import { ROLE_OPTIONS } from '../../../../../shared/automation/presets';
import { TASK_STATUS_TITLES } from '../../../../../shared/automation/task-readiness';

@Component({ selector: 'sat-automation-queue', standalone: true, imports: [DatePipe, DecimalPipe, AccordionModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './automation-queue.component.html', styleUrl: './automation-queue.component.scss' })
export class AutomationQueueComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly refresh = new Subject<void>();
  public readonly selectedId = signal<string | null>(null);
  @Input() public set runId(value: string | null) { this.selectedId.set(value); }
  @Output() public readonly openTask = new EventEmitter<string>();
  @Output() public readonly configure = new EventEmitter<void>();
  @Output() public readonly changed = new EventEmitter<void>();
  public readonly error = signal('');
  public readonly busy = signal(false);
  public readonly statusTitles = RUN_STATUS_TITLES;
  public readonly taskTitles = TASK_STATUS_TITLES;
  public readonly phaseTitles = RUN_PHASE_TITLES;
  public readonly lanes = QUEUE_LANES;
  public readonly recentLimit = QUEUE_LIMITS.recent;
  public readonly eventTitles = RUN_EVENT_TITLES;
  public readonly runStatus = RunStatus;
  public readonly runAction = RunAction;
  public readonly tokenMeter = TokenMeter;
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
  public items(lane: QueueLane): QueueItem[] { return this.snapshot().items.filter((item) => QueuePresentation.lane(item) === lane); }
  public health(item: QueueItem): string { return QueuePresentation.health(item, Date.parse(this.snapshot().serverTime), this.snapshot().host); }
  public role(role: string): string { return ROLE_OPTIONS.find((entry) => entry.value === role)?.label ?? role; }
  public currentRole(item: QueueItem): string { return this.role(item.pipeline.at(item.stage)?.role ?? ''); }
  public duration(at: string | undefined): string { return at ? `${Math.max(0, Math.floor((Date.parse(this.snapshot().serverTime) - Date.parse(at)) / 1000))} с` : 'нет данных'; }
  public progress(text: string): string { return RunProgressText.format(text) || text; }
  public select(id: string): void { this.selectedId.set(id); this.error.set(''); }
  public action(item: QueueItem, action: RunAction): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.http.post<{ run?: AgentRun }>(`/api/automation/runs/${item.id}/${action}`, {}).pipe(
      tap((result) => { if (result.run) this.selectedId.set(result.run.id); this.refresh.next(); this.changed.emit(); }),
      catchError((error: unknown) => { this.error.set(this.message(error)); return EMPTY; }),
      finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }
  private message(error: unknown): string {
    const value = error as { error?: { error?: { message?: string } }; message?: string };
    return value.error?.error?.message ?? value.message ?? 'Не удалось обновить очередь.';
  }
}
