import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { PopoverModule } from 'primeng/popover';
import { ProgressBarModule } from 'primeng/progressbar';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { EMPTY, catchError, delay, exhaustMap, filter, map, of, switchMap, tap, timer } from 'rxjs';
import type { TaskStatus, TaskType } from './models/tracker.models';
import { TrackerStore } from './services/tracker-store.service';
import { WorkspaceService } from './services/workspace.service';
import { ToolbarComponent } from './components/toolbar/toolbar.component';
import { BoardComponent } from './components/board/board.component';
import { TaskDialogComponent } from './components/task-dialog/task-dialog.component';
import { TagsPanelComponent } from './components/tags-panel/tags-panel.component';
import { BackupPanelComponent } from './components/backup-panel/backup-panel.component';
import { InstructionsDialogComponent } from './components/instructions-dialog/instructions-dialog.component';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { AutomationLaunchService } from './services/automation-launch.service';
import { SidebarComponent } from './components/sidebar/sidebar.component';

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
    SidebarComponent,
    BoardComponent,
    TaskDialogComponent,
    TagsPanelComponent,
    BackupPanelComponent,
    InstructionsDialogComponent,
    RouterOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  public readonly automationLauncher = inject(AutomationLaunchService);
  private readonly destroyRef = inject(DestroyRef);
  public readonly store = inject(TrackerStore);
  private readonly workspace = inject(WorkspaceService);

  public readonly sidebarOpen = signal(!window.matchMedia('(max-width: 768px)').matches);

  public readonly showTags = signal(false);
  public readonly showBackups = signal(false);
  public readonly showInstructions = signal(false);
  private readonly router = inject(Router);
  private readonly currentPath = toSignal(this.router.events.pipe(
    filter((event): event is NavigationEnd => event instanceof NavigationEnd),
    map(event => event.urlAfterRedirects.split('?')[0]),
  ), { initialValue: '' });
  public readonly boardVisible = computed(() => !this.currentPath().startsWith('/automation/'));
  public readonly runsVisible = computed(() => this.currentPath().startsWith('/automation/runs/'));

  public openBoard(): void {
    void this.router.navigate(['/']);
  }

  public openAutomation(taskId: string | null = null): void {
    void this.router.navigate(['/automation/settings', taskId ? 'launch' : 'team'], {
      queryParams: taskId ? { scope: 'task', taskId, workspace: this.workspace.current() } : undefined,
    });
  }

  public launchTask(id: string): void {
    this.automationLauncher.preview(id).pipe(tap(runId => runId ? this.openQueue(runId) : this.openAutomation(id)),
      catchError(() => { this.openAutomation(id); return EMPTY; }), takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  public openQueue(id: string | null): void {
    void this.router.navigate(['/automation/runs', id ? 'queue' : 'history'], {
      queryParams: id ? { run: id, workspace: this.workspace.current() } : undefined,
    });
  }
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
    const compact = window.matchMedia('(max-width: 768px)');
    const resizeSidebar = (event: MediaQueryListEvent): void => this.sidebarOpen.set(!event.matches);
    compact.addEventListener('change', resizeSidebar);
    this.destroyRef.onDestroy(() => compact.removeEventListener('change', resizeSidebar));
    void this.store.init();
    void this.openLinkedAutomation();
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd && compact.matches),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.sidebarOpen.set(false));
    timer(this.POLL_INTERVAL_MS, this.POLL_INTERVAL_MS).pipe(
      filter(() => !this.createMode() && !this.store.dragging()),
      exhaustMap(() => this.store.refresh(true)), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  private async openLinkedAutomation(): Promise<void> {
    const query = new URLSearchParams(location.search);
    const legacyRun = query.get('automationRun');
    const run = legacyRun ?? query.get('run');
    const workspace = query.get('workspace');
    if (!run && !query.get('taskId')) return;

    if (workspace && workspace !== this.workspace.current()) {
      try {
        await this.workspace.load();
        if (!this.workspace.workspaces().some(item => item.name === workspace)) return;
        await this.workspace.activate(workspace, true);
      } catch {
        // The current workspace remains available if activation fails.
      }
      return;
    }

    if (legacyRun) {
      const eventId = Number(query.get('eventId'));
      await this.router.navigate(['/automation/runs/history'], {
        queryParams: { run, workspace, eventId: Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null },
        replaceUrl: true,
      });
    }
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
