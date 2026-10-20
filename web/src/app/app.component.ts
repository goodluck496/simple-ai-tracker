import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { PopoverModule } from 'primeng/popover';
import { ProgressBarModule } from 'primeng/progressbar';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { delay, of, switchMap } from 'rxjs';
import type { TaskStatus, TaskType } from './models/tracker.models';
import { TrackerStore } from './services/tracker-store.service';
import { ToolbarComponent } from './components/toolbar/toolbar.component';
import { BoardComponent } from './components/board/board.component';
import { TaskDialogComponent } from './components/task-dialog/task-dialog.component';
import { TagsPanelComponent } from './components/tags-panel/tags-panel.component';
import { BackupPanelComponent } from './components/backup-panel/backup-panel.component';
import { InstructionsDialogComponent } from './components/instructions-dialog/instructions-dialog.component';

/** Задержка перед показом полосы загрузки: быстрые ответы не мигают. */
const PROGRESS_DELAY_MS = 140;

/** Корневой компонент: шапка с поиском и действиями, канбан-доска и боковая карточка. */
@Component({
  selector: 'sat-root',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    PopoverModule,
    ProgressBarModule,
    TagModule,
    TooltipModule,
    ToolbarComponent,
    BoardComponent,
    TaskDialogComponent,
    TagsPanelComponent,
    BackupPanelComponent,
    InstructionsDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  public readonly store = inject(TrackerStore);

  public readonly showTags = signal(false);
  public readonly showBackups = signal(false);
  public readonly showInstructions = signal(false);
  public readonly createMode = signal(false);
  public readonly createType = signal<TaskType>('task');
  public readonly createStatus = signal<TaskStatus>('backlog');
  public readonly createParentId = signal<string | null>(null);

  /** Идёт загрузка или запись: опрос доски (он тихий) сюда не попадает. */
  private readonly loadingActive = computed(() => this.store.loading() || this.store.busy());

  /** Полоса загрузки под шапкой: появляется, только если запрос длится дольше 140 мс. */
  public readonly showProgress = toSignal(
    toObservable(this.loadingActive).pipe(switchMap((active) => (active ? of(true).pipe(delay(PROGRESS_DELAY_MS)) : of(false)))),
    { initialValue: false },
  );

  public readonly activeCount = computed(() => {
    const counts = this.store.counts();
    return (counts['in_progress'] ?? 0) + (counts['questions'] ?? 0) + (counts['testing'] ?? 0) + (counts['review'] ?? 0);
  });

  /** Автообновление доски раз в 4 секунды (как в прежней версии). */
  private readonly POLL_INTERVAL_MS = 4000;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  public ngOnInit(): void {
    void this.store.init();
    this.pollTimer = setInterval(() => {
      // Пока пользователь редактирует карточку или тащит её по доске, опрос замирает:
      // любой тик в этот момент виден как рывок.
      if (this.createMode() || this.store.dragging()) return;
      // Тихий опрос: не включаем индикатор загрузки и не перерисовываем доску зря.
      void this.store.refresh(true);
    }, this.POLL_INTERVAL_MS);
  }

  public ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Количество задач в статусе (0, если таких нет). */
  public countOf(status: string): number {
    return this.store.counts()[status] ?? 0;
  }

  public onCreateType(type: TaskType): void {
    this.startCreate(type);
  }

  /** Создание подзадачи из группы фичи на доске (всегда попадает в бэклог). */
  public onAddSubtask(event: { parentId: string; type: TaskType }): void {
    this.createParentId.set(event.parentId);
    this.createStatus.set('backlog');
    this.startCreate(event.type);
  }

  /** Удаление карточки с доски. */
  public onDeleteTask(id: string): void {
    void this.store.deleteTask(id);
  }

  /** Быстрое добавление из колонки: новая карточка всегда создаётся в бэклоге. */
  public onQuickAdd(status: TaskStatus): void {
    this.createStatus.set(status === 'backlog' ? 'backlog' : 'backlog');
    this.startCreate('task');
  }

  public startCreate(type: TaskType): void {
    if (!this.createMode()) this.createParentId.set(null);
    this.createType.set(type);
    this.createMode.set(true);
    this.store.closeCard();
  }

  public closeCreate(): void {
    this.createMode.set(false);
    this.createStatus.set('backlog');
    this.createParentId.set(null);
  }

  public closeCard(): void {
    this.store.closeCard();
  }
}
