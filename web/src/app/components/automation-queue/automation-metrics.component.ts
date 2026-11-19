import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Output, afterNextRender, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageModule } from 'primeng/message';
import { PanelModule } from 'primeng/panel';
import { SkeletonModule } from 'primeng/skeleton';
import { TableModule } from 'primeng/table';
import { catchError, combineLatest, map, of, startWith, switchMap } from 'rxjs';
import type { ImprovementMetrics, ImprovementOccurrence, ImprovementPeriod } from '../../../../../shared/automation/improvement-metrics';
import { WorkspaceService } from '../../services/workspace.service';

type MetricsState = { loading: boolean; data: ImprovementMetrics | null; error: string };

@Component({
  selector: 'sat-automation-metrics', standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule, ButtonModule, DatePickerModule, MessageModule, PanelModule, SkeletonModule, TableModule],
  templateUrl: './automation-metrics.component.html', styleUrl: './automation-metrics.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationMetricsComponent {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly http = inject(HttpClient);
  private readonly workspace = inject(WorkspaceService);
  @Output() public readonly navigate = new EventEmitter<'queue' | 'history'>();
  @Output() public readonly inspect = new EventEmitter<ImprovementOccurrence>();
  @Output() public readonly openTask = new EventEmitter<{ taskId: string; runId: string }>();
  @Output() public readonly periodChanged = new EventEmitter<void>();
  private readonly initialTo = new Date();
  public dates: Date[] = [new Date(this.initialTo.getTime() - 30 * 86400000), this.initialTo];
  public readonly period = signal<ImprovementPeriod>({ from: this.dates[0].toISOString(), to: this.dates[1].toISOString() });
  private readonly refresh = signal(0);
  public readonly validationError = signal('');
  public readonly state = toSignal(combineLatest([
    toObservable(this.period), toObservable(this.workspace.current), toObservable(this.refresh),
  ]).pipe(switchMap(([period]) => this.http.get<ImprovementMetrics>('/api/automation/metrics', { params: { ...period } }).pipe(
    map(data => ({ loading: false, data, error: '' })),
    catchError(() => of({ loading: false, data: null, error: 'Не удалось загрузить метрики. Повторите попытку.' })),
    startWith({ loading: true, data: null, error: '' }),
  ))), { initialValue: { loading: true, data: null, error: '' } as MetricsState });

  constructor() { afterNextRender(() => this.element.nativeElement.querySelector<HTMLElement>('#metrics-heading')?.focus()); }

  public applyPeriod(): void {
    const [from, last] = this.dates ?? [];
    if (!(from instanceof Date) || !(last instanceof Date) || !Number.isFinite(+from) || !Number.isFinite(+last) || from > last) {
      this.validationError.set('Выберите начало и конец периода.'); return;
    }
    // The date picker selects inclusive local calendar dates; the API uses [from, to).
    const start = new Date(from); start.setHours(0, 0, 0, 0);
    const to = new Date(last); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + 1);
    this.validationError.set(''); this.periodChanged.emit();
    this.period.set({ from: start.toISOString(), to: to.toISOString() });
  }

  public retry(): void { this.refresh.update(value => value + 1); }
  public reviewLabel(value: ImprovementOccurrence['reviewState']): string {
    return value === 'repeated_after_done' ? 'Повтор после исправления' : value === 'repeated' ? 'Повторный случай' : 'Ознакомиться';
  }
}
