import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { ProgressBarModule } from 'primeng/progressbar';
import { RunActivity } from '../../../../../shared/automation/queue-activity';
import { RUN_PHASE_TITLES, type QueueItem } from '../../../../../shared/automation/queue';

@Component({
  selector: 'sat-run-activity', standalone: true, imports: [ProgressBarModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let activity = state;
    <div class="run-activity" [attr.data-state]="activity.state" [class.compact]="compact">
      <div class="activity-heading"><span class="activity-dot" [class.live]="activity.animated" aria-hidden="true"></span><strong>{{ activity.label }}</strong></div>
      @if (activity.animated) {
        <p-progressbar mode="indeterminate" [style]="{height: '.3rem'}" ariaLabel="Операция выполняется, процент неизвестен" />
      }
      @if (!compact) {
        <p>Сейчас: {{ item.phase ? phases[item.phase] : 'Ожидание этапа' }} · {{ elapsed(activity.phaseAge) }}</p>
        <p>Ответ worker: {{ elapsed(activity.heartbeatAge) }} назад · без новых событий: {{ elapsed(activity.eventAge) }}</p>
        @if (activity.animated) { <p class="muted">Точный процент этой операции неизвестен. Ответ worker подтверждает связь, но не продвижение команды.</p> }
        @if (activity.total) {
          <p>Завершено этапов агентов: {{ activity.completed }} / {{ activity.total }} ({{ activity.percent }}%)</p>
          <p-progressbar [value]="activity.percent ?? 0" [showValue]="false" [style]="{height: '.3rem'}" ariaLabel="Доля завершённых этапов агентов" />
        }
      } @else if (activity.animated) { <span class="muted">{{ item.phase ? phases[item.phase] : 'Операция' }}: {{ elapsed(activity.phaseAge) }} · ответ {{ elapsed(activity.heartbeatAge) }} назад</span> }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .run-activity { display: grid; gap: .3rem; padding: .6rem; border: 1px solid var(--p-content-border-color); border-radius: .4rem; }
    .run-activity.compact { padding: 0; border: 0; font-size: .8rem; }
    .activity-heading { display: flex; align-items: center; gap: .4rem; }
    .activity-dot { flex: 0 0 .5rem; height: .5rem; border-radius: 50%; background: var(--p-text-muted-color); }
    .activity-dot.live { background: var(--p-primary-color); animation: worker-pulse 1.5s ease-in-out infinite; }
    [data-state="stale"], [data-state="quiet"], [data-state="disconnected"] { color: var(--p-orange-400); }
    p { margin: 0; overflow-wrap: anywhere; } .muted { color: var(--p-text-muted-color); font-size: .8rem; }
    @keyframes worker-pulse { 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) {
      .activity-dot.live { animation: none; }
      :host ::ng-deep .p-progressbar-indeterminate .p-progressbar-value { animation: none !important; }
      :host ::ng-deep .p-progressbar-indeterminate .p-progressbar-value::before,
      :host ::ng-deep .p-progressbar-indeterminate .p-progressbar-value::after { animation: none !important; }
    }
  `,
})
export class RunActivityComponent {
  @Input({ required: true }) public item!: QueueItem;
  @Input({ required: true }) public now!: number;
  @Input() public connected = true;
  @Input() public compact = false;
  public readonly phases = RUN_PHASE_TITLES;
  public readonly elapsed = RunActivity.elapsed;
  public get state() { return RunActivity.evaluate(this.item, this.now, this.connected); }
}
