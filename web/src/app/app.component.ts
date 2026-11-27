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
import { RunsToolbarComponent } from './components/runs-toolbar/runs-toolbar.component';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { AutomationLaunchService } from './services/automation-launch.service';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { type DialogTab, isDialogTab, resolveDefaultTab, TaskLinkService } from './services/task-link';

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
    RunsToolbarComponent,
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
  public readonly taskLink = inject(TaskLinkService);

  public readonly sidebarOpen = signal(!window.matchMedia('(max-width: 768px)').matches);

  public readonly showTags = signal(false);
  public readonly showBackups = signal(false);
  public readonly showInstructions = signal(false);
  private readonly router = inject(Router);
  private readonly currentPath = toSignal(this.router.events.pipe(
    filter((event): event is NavigationEnd => event instanceof NavigationEnd),
    map(event => event.urlAfterRedirects.split('?')[0]),
  ), { initialValue: this.router.url.split('?')[0] });
  public readonly boardVisible = computed(() => !this.currentPath().startsWith('/automation/'));
  public readonly runsVisible = computed(() => this.currentPath().startsWith('/automation/runs'));

  public readonly activeItemId = signal<string | null>(null);
  public readonly activeItemTab = signal<DialogTab | null>(null);

  public openBoard(): void {
    this.store.clearError();
    void this.taskLink.navigateToBoard();
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
    this.initItemRouting();
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd && compact.matches),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.sidebarOpen.set(false));
    timer(this.POLL_INTERVAL_MS, this.POLL_INTERVAL_MS).pipe(
      filter(() => !this.createMode() && !this.store.dragging()),
      exhaustMap(() => this.store.refresh(true)), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  private routeSeq = 0;

  private initItemRouting(): void {
    void this.handleRoute(this.router.url);
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(event => void this.handleRoute(event.urlAfterRedirects));
  }

  private async handleRoute(url: string): Promise<void> {
    const seq = ++this.routeSeq;
    const [pathPart, queryPart] = url.split('?');
    const query = new URLSearchParams(queryPart ?? '');

    if (pathPart.startsWith('/automation/')) {
      if (this.createMode()) this.createMode.set(false);
      this.activeItemId.set(null);
      this.activeItemTab.set(null);
      return;
    }

    const segments = pathPart.replace(/^\/+/, '').split('/');
    if (segments[0] !== 'item') {
      if (this.createMode()) this.createMode.set(false);
      if (this.activeItemId() || this.store.openTask()) {
        this.activeItemId.set(null);
        this.activeItemTab.set(null);
        this.store.closeCard();
      }
      return;
    }

    const requestedWorkspace = query.get('workspace');
    if (requestedWorkspace && requestedWorkspace !== this.workspace.current()) {
      try {
        await this.workspace.load();
        if (this.routeSeq !== seq) return;
        const exists = this.workspace.workspaces().some(item => item.name === requestedWorkspace);
        if (!exists) {
          this.store.setError(`Пространство «${requestedWorkspace}» не найдено.`);
          return;
        }
        await this.workspace.activate(requestedWorkspace, true);
        return;
      } catch {
        if (this.routeSeq !== seq) return;
        this.store.setError(`Не удалось переключиться на пространство «${requestedWorkspace}».`);
        return;
      }
    }

    if (segments[1] === 'create') {
      this.store.closeCard();
      this.activeItemId.set(null);
      this.activeItemTab.set(null);
      const state = (window.history.state ?? {}) as {
        createType?: TaskType;
        createStatus?: TaskStatus;
        createParentId?: string | null;
      };
      this.createType.set(state.createType ?? 'task');
      this.createStatus.set(state.createStatus ?? 'backlog');
      this.createParentId.set(state.createParentId ?? null);
      this.createMode.set(true);
      if (!requestedWorkspace) {
        void this.taskLink.navigateToCreate({ replaceUrl: true, workspace: this.workspace.current(), state });
      }
      return;
    }

    const taskId = segments[1];
    if (!taskId) return;

    this.createMode.set(false);
    this.activeItemId.set(taskId);

    if (this.store.openTask()?.id !== taskId) {
      await this.store.openCard(taskId);
      if (this.routeSeq !== seq) return;
    }

    const card = this.store.openTask();
    if (!card) return;

    const rawTab = segments[2];
    const validTab = isDialogTab(rawTab) ? rawTab : null;
    const resolvedTab = validTab ?? resolveDefaultTab(card);
    this.activeItemTab.set(resolvedTab);

    if (!validTab || !requestedWorkspace || rawTab !== resolvedTab) {
      void this.taskLink.navigateToTask(taskId, resolvedTab, {
        replaceUrl: true,
        workspace: this.workspace.current(),
        state: window.history.state,
      });
    }
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
    this.createParentId.set(null);
    this.createType.set(type);
    this.createStatus.set('backlog');
    void this.taskLink.navigateToCreate({
      state: { createType: type, createStatus: 'backlog', createParentId: null, inAppOrigin: true },
    });
  }

  /** Создание подзадачи из группы фичи на доске (всегда попадает в бэклог). */
  public onAddSubtask(event: { parentId: string; type: TaskType }): void {
    this.createParentId.set(event.parentId);
    this.createType.set(event.type);
    this.createStatus.set('backlog');
    void this.taskLink.navigateToCreate({
      state: { createType: event.type, createStatus: 'backlog', createParentId: event.parentId, inAppOrigin: true },
    });
  }

  /** Удаление карточки с доски. */
  public onDeleteTask(id: string): void {
    void this.store.deleteTask(id);
  }

  /** Быстрое добавление из колонки: новая карточка всегда создаётся в бэклоге. */
  public onQuickAdd(status: TaskStatus): void {
    this.createParentId.set(null);
    this.createType.set('task');
    this.createStatus.set(status);
    void this.taskLink.navigateToCreate({
      state: { createType: 'task', createStatus: status, createParentId: null, inAppOrigin: true },
    });
  }

  public startCreate(type: TaskType): void {
    this.createType.set(type);
    void this.taskLink.navigateToCreate({
      state: { createType: type, createStatus: this.createStatus(), createParentId: this.createParentId(), inAppOrigin: true },
    });
  }

  public closeCreate(): void {
    this.closeDialogOrNavigateBoard();
  }

  public closeCard(): void {
    this.closeDialogOrNavigateBoard();
  }

  private closeDialogOrNavigateBoard(): void {
    const navState = window.history.state as { inAppOrigin?: boolean } | null;
    if (navState?.inAppOrigin && window.history.length > 1) {
      window.history.back();
    } else {
      void this.taskLink.navigateToBoard();
    }
  }

  public onItemTabChange(tab: DialogTab): void {
    const card = this.store.openTask();
    if (!card) return;
    this.activeItemTab.set(tab);
    void this.taskLink.navigateToTask(card.id, tab, {
      replaceUrl: true,
      state: window.history.state,
    });
  }

  public onOpenLinkedTask(id: string): void {
    void this.taskLink.navigateToTask(id, undefined, {
      state: { inAppOrigin: true },
    });
  }
}
