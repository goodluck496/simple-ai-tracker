import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { PopoverModule } from 'primeng/popover';
import { ProgressBarModule } from 'primeng/progressbar';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { EMPTY, catchError, delay, exhaustMap, filter, of, switchMap, tap, timer } from 'rxjs';
import type { TaskStatus, TaskType } from './models/tracker.models';
import { TrackerStore } from './services/tracker-store.service';
import { ToolbarComponent } from './components/toolbar/toolbar.component';
import { BoardComponent } from './components/board/board.component';
import { TaskDialogComponent } from './components/task-dialog/task-dialog.component';
import { TagsPanelComponent } from './components/tags-panel/tags-panel.component';
import { BackupPanelComponent } from './components/backup-panel/backup-panel.component';
import { InstructionsDialogComponent } from './components/instructions-dialog/instructions-dialog.component';
import { WorkspaceSelectorComponent } from './components/workspace-selector/workspace-selector.component';
import { AutomationPanelComponent } from './components/automation-panel/automation-panel.component';
import { AutomationQueueComponent } from './components/automation-queue/automation-queue.component';
import { AutomationLaunchService } from './services/automation-launch.service';
import { DialogModule } from 'primeng/dialog';

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
    WorkspaceSelectorComponent,
    AutomationPanelComponent,
    AutomationQueueComponent,
    DialogModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  public readonly automationLauncher = inject(AutomationLaunchService);
  private readonly destroyRef = inject(DestroyRef);
  public readonly store = inject(TrackerStore);

  public readonly showTags = signal(false);
  public readonly showBackups = signal(false);
  public readonly showInstructions = signal(false);
  public showAutomation = false;
  public automationTaskId: string | null = null;
  public automationMessage = '';
  public openAutomation(taskId: string | null = null, message = ''): void {
    this.automationTaskId = taskId; this.automationMessage = message; this.showAutomation = true;
  }
  public launchTask(id: string): void {
    this.openAutomation(id);
  }
  public showQueue = false;
  public queueRunId: string | null = null;
  public openQueue(id: string | null): void { this.queueRunId = id; this.showQueue = true; }
  public openQueueTask(id: string): void { this.showQueue = false; this.showAutomation = false; void this.store.openCard(id); }
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

  public ngOnInit(): void {
    void this.store.init();
    timer(this.POLL_INTERVAL_MS, this.POLL_INTERVAL_MS).pipe(
      filter(() => !this.createMode() && !this.store.dragging()),
      exhaustMap(() => this.store.refresh(true)), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
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
