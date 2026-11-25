import { RunProfileEditorComponent } from './run-profile-editor.component';
import type { ProposedFix } from '../../../../../shared/automation/contracts';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, afterRenderEffect, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { PanelModule } from 'primeng/panel';
import { PopoverModule } from 'primeng/popover';
import { MessageModule } from 'primeng/message';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { PROJECT_LIMITS, ProjectAction, ProjectRequestStatus, type ProjectDiff, type ProjectRequest } from '../../../../../shared/automation/project';
import type { ModelCatalogInput, ModelOption } from '../../../../../shared/automation/model-catalog';
import { CheckboxModule } from 'primeng/checkbox';
import { TokenMeter } from '../../../../../shared/automation/token-usage';
import { RUN_BUDGET_FIELDS, RunBudget, type RunBudgetKey } from '../../../../../shared/automation/budget';
import { agentProfileName } from '../../../../../shared/automation/team-profiles';
import { runFailure } from '../../../../../shared/automation/run-failure';
import { RunConsoleComponent } from '../run-console/run-console.component';
import { RunActivityComponent } from './run-activity.component';
import { ACTIVITY_TIMING } from '../../../../../shared/automation/queue-activity';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { EMPTY, Subject, catchError, combineLatest, defer, exhaustMap, filter, finalize, map, merge, of, switchMap, take, tap, timeout, timer, type Observable } from 'rxjs';
import { AUTOMATION_TIMING, EVIDENCE_AGENT_ROLES, RESUMABLE_RUN_STATUSES, RunStatus, RunAction, type AgentRun, type AutomationSettings, type RunEvent } from '../../../../../shared/automation/contracts';
import { QUEUE_LANES, QUEUE_LIMITS, RUN_EVENT_TITLES, RUN_PHASE_TITLES, RUN_STATUS_TITLES, INTEGRATION_STATE_TITLES, QueuePresentation, RunProgressText,
  type QueueItem, type QueueSnapshot, type QueueLane } from '../../../../../shared/automation/queue';
import { ROLE_OPTIONS } from '../../../../../shared/automation/presets';
import { TASK_STATUS_TITLES } from '../../../../../shared/automation/task-readiness';
import { WorkspaceService } from '../../services/workspace.service';
import { TrackerStore } from '../../services/tracker-store.service';
import { TaskDialogComponent } from '../task-dialog/task-dialog.component';
import { filterQueueItems } from './queue-search';
import { formatQueueDate, sortRunHistory } from './queue-dates';

import { PipelineFlowComponent } from '../automation-panel/pipeline-flow.component';
import { AutomationMetricsComponent } from './automation-metrics.component';
import { GitDiffViewerComponent } from '../git-diff-viewer/git-diff-viewer.component';
import type { CheckEvidence, ImprovementOccurrence, ImprovementPeriod } from '../../../../../shared/automation/improvement-metrics';
import { publicUrl } from '../../services/public-url';

type RunsView = 'queue' | 'history' | 'metrics';
type RunPage = 'diagnosis' | 'commit-diff' | 'branch-diff';
const HISTORY_LANES = ['attention', 'finished', 'running', 'queued'] as const;

@Component({ selector: 'sat-automation-queue', standalone: true, imports: [RunProfileEditorComponent, DatePipe, DecimalPipe, RunConsoleComponent, RunActivityComponent, TableModule, ButtonModule, FormsModule, CheckboxModule, SelectModule, PanelModule, PopoverModule, MessageModule, InputTextModule, InputNumberModule, PipelineFlowComponent, AutomationMetricsComponent, TaskDialogComponent, GitDiffViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './automation-queue.component.html', styleUrl: './automation-queue.component.scss' })
export class AutomationQueueComponent implements OnInit {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly workspace = inject(WorkspaceService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  public readonly store = inject(TrackerStore);
  private readonly refresh = new Subject<void>();
  public readonly selectedId = signal<string | null>(null);
  public readonly view = signal<RunsView>('queue');
  public readonly historyMode = computed(() => this.view() === 'history');
  public readonly metricsMode = computed(() => this.view() === 'metrics');
  public readonly views = [
    { id: 'queue', label: 'Рабочая очередь' }, { id: 'history', label: 'История' }, { id: 'metrics', label: 'Метрики' },
  ] as const;
  private routedRun: string | null = null;
  public readonly selectedOccurrence = signal<ImprovementOccurrence | null>(null);
  public readonly metricsPeriod = signal<ImprovementPeriod | null>(null);
  public readonly evidenceLoading = signal(false);
  public readonly evidenceError = signal('');
  public readonly sourceEventId = signal<number | null>(null);
  public readonly evidenceExpanded = signal(false);
  public readonly evidenceImageUrl = publicUrl;
  private readonly selectedEventId = computed(() => this.selectedOccurrence()?.eventId ?? this.sourceEventId());
  public readonly historyTask = signal('');
  public readonly showDetails = signal(false);
  public readonly leftSidebarOpen = signal(true);
  public readonly inspectorWidth = signal<number>(this.loadInspectorWidth());
  public readonly isResizingInspector = signal(false);
  public readonly activeLaneFilter = signal<string>('all');
  public readonly confirmation = signal<'cleanup' | 'delete' | null>(null);
  public discard = false;
  private readonly selectedCache = signal<QueueItem | undefined>(undefined);
  public readonly taskContext = signal<{ taskId: string; runId: string } | null>(null);
  public readonly error = signal('');
  public readonly pollError = signal('');
  private readonly dismissedPollError = signal('');
  public readonly pollFeedback = computed(() => this.pollError() === this.dismissedPollError() ? '' : this.pollError());
  public dismissPollError(): void { this.dismissedPollError.set(this.pollError()); }
  public readonly queueConnected = signal(false);
  private readonly receivedAt = signal(performance.now());
  private readonly clock = toSignal(timer(0, ACTIVITY_TIMING.tickMs).pipe(map(() => performance.now())), { initialValue: performance.now() });
  public readonly dataFresh = computed(() => this.queueConnected() && this.clock() - this.receivedAt() < ACTIVITY_TIMING.snapshotMs);
  public readonly notice = signal('');
  public readonly busy = signal(false);
  public readonly runPage = signal<RunPage | null>(null);
  private readonly diagnosed = signal<{ runId: string; fix: ProposedFix } | null>(null);
  public readonly currentFix = computed(() => {
    const diagnosis = this.diagnosed();
    return diagnosis?.runId === this.selectedId() ? diagnosis.fix : this.selected()?.proposedFix;
  });
  public readonly budgetEditing = signal(false);
  public deployPreviewPatch = false;
  public readonly budgetFields = RUN_BUDGET_FIELDS;
  public budgetDraft: Partial<Record<RunBudgetKey, number | null>> = {};
  private originalBudget: Partial<Record<RunBudgetKey, number>> = {};
  public editBudget(run: AgentRun): void {
    this.originalBudget = Object.fromEntries(this.budgetFields.map(field => [field.key, RunBudget.value(run, field)]));
    this.budgetDraft = { ...this.originalBudget };
    this.budgetEditing.set(true);
  }
  public saveBudget(run: AgentRun): void {
    if (this.busy()) return;
    this.busy.set(true);
    const changes = this.budgetFields.filter(({ key }) => this.budgetDraft[key] !== this.originalBudget[key]);
    this.http.post(`/api/automation/runs/${run.id}/budget`, Object.fromEntries(changes.map(({ key }) => [key, this.budgetDraft[key]])))
      .pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.budgetEditing.set(false); this.refresh.next(); this.notice.set('Лимиты сохранены. Чтобы продолжить этот прогон, нажмите «Продолжить».'); },
        error: (error: unknown) => this.error.set(this.message(error)),
      });
  }
  public profileChanged(): void { this.refresh.next(); this.notice.set('Профиль этапа обновлён в этом запуске. Рабочая ветка сохранена.'); }
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
  public readonly connectionFailure = computed(() => {
    const detail = this.detail();
    if (!detail || ![RunStatus.Running, RunStatus.Failed, RunStatus.Interrupted, RunStatus.Queued].some(status => status === detail.run.status)) return undefined;
    const direct = runFailure(detail.run.summary);
    if (direct) return direct;
    const events = detail.events;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.kind !== 'failed' && event.kind !== 'interrupted') continue;
      return runFailure(event.text) ?? (/подробности доступны у исполнителя/i.test(event.text)
        ? runFailure(events.slice(Math.max(0, index - 12), index).map(entry => entry.text).join('\n')) : undefined);
    }
    return undefined;
  });
  private readonly listContext = computed(() => ({ view: this.view(), task: this.historyTask() }));
  private readonly emptySnapshot: QueueSnapshot = { items: [], host: { online: false }, serverTime: new Date().toISOString() };
  private readonly listResponse = toSignal(combineLatest([toObservable(this.listContext), merge(timer(0, AUTOMATION_TIMING.pollMs), this.refresh)]).pipe(
    switchMap(([context]) => context.view === 'metrics' ? EMPTY : this.http.get<QueueSnapshot>(
      context.view === 'history' ? `/api/automation/history${context.task ? '?taskId=' + encodeURIComponent(context.task) : ''}` : '/api/automation/queue',
    ).pipe(
      tap(() => {
        this.receivedAt.set(performance.now()); this.queueConnected.set(true);
        this.pollError.set(''); this.dismissedPollError.set('');
      }),
      map(snapshot => ({ context, snapshot })),
      catchError((error: unknown) => { this.queueConnected.set(false); this.pollError.set(this.message(error)); return EMPTY; }),
    )),
  ));
  public readonly snapshot = computed(() => {
    const response = this.listResponse();
    return response?.context === this.listContext() ? response.snapshot : this.emptySnapshot;
  });
  public readonly now = computed(() => Date.parse(this.snapshot().serverTime) + Math.max(0, this.clock() - this.receivedAt()));
  public readonly selected = computed(() => {
    const id = this.selectedId();
    const snapshot = this.snapshot().items.find(run => run.id === id);
    const detail = this.detail()?.item;
    if (detail?.id === id && (!snapshot || detail.updatedAt > snapshot.updatedAt)) return detail;
    return snapshot ?? (this.selectedCache()?.id === id ? this.selectedCache() : undefined);
  });
  public readonly detail = toSignal(combineLatest([toObservable(this.selectedId), toObservable(this.selectedEventId), toObservable(this.workspace.current), merge(timer(0, AUTOMATION_TIMING.pollMs), this.refresh)]).pipe(
    switchMap(([id, eventId, workspace]) => id ? defer(() => {
      this.evidenceLoading.set(true);
      this.evidenceError.set('');
      return this.http.get<{ run: AgentRun; item?: QueueItem; events: RunEvent[]; selectedEvent?: RunEvent;
      checks?: CheckEvidence[]; selectedOccurrence?: ImprovementOccurrence; userAcceptance?: { id: number; at: string };
      previewPatch: { available: boolean; active: boolean; pending: boolean } }>(`/api/automation/runs/${encodeURIComponent(id)}${eventId === null ? '' : '?eventId=' + eventId}`).pipe(
      filter(response => this.workspace.current() === workspace && this.selectedId() === id && this.selectedEventId() === eventId),
      catchError((error: unknown) => {
        this.evidenceError.set(this.message(error));
        if (eventId === null) this.error.set(this.message(error));
        return of(null);
      }),
      finalize(() => this.evidenceLoading.set(false)),
    ); }) : of(null)),
  ), { initialValue: null });
  public readonly displayedOccurrence = computed(() => {
    const occurrence = this.detail()?.selectedOccurrence;
    return occurrence?.runId === this.selectedId() && occurrence?.eventId === this.selectedEventId()
      ? occurrence : this.selectedOccurrence();
  });
  public readonly selectedCheck = computed(() => {
    const detail = this.detail();
    return detail?.run.id === this.selectedId() ? detail?.checks?.find(check => check.eventId === this.sourceEventId()) : undefined;
  });
  public readonly selectedEvidence = computed(() => {
    const occurrence = this.displayedOccurrence(); const detail = this.detail();
    if (!occurrence || detail?.run.id !== occurrence.runId) return null;
    const event = detail.selectedEvent ?? detail.events.find(event => event.id === occurrence.eventId);
    return event?.id === occurrence.eventId && event.runId === occurrence.runId ? event : null;
  });
  public readonly laneItems = computed(() => {
    const raw = this.snapshot().items;
    const history = this.historyMode();
    const search = this.search();
    const sorted = history ? sortRunHistory(raw) : raw;
    const filtered = filterQueueItems(sorted, search);
    const map = new Map<QueueLane, QueueItem[]>();
    for (const lane of this.lanes) {
      map.set(lane.id, []);
    }
    for (const item of filtered) {
      const lane = QueuePresentation.lane(item);
      map.get(lane)?.push(item);
    }
    return map;
  });
  public items(lane: QueueLane): QueueItem[] { return this.laneItems().get(lane) ?? []; }
  public visibleCount(): number { return this.visibleLanes().reduce((sum, lane) => sum + this.items(lane.id).length, 0); }
  public archivedItems(): AgentRun[] { return sortRunHistory(this.archived() ?? []); }
  public timestamp(value: string | undefined): string { return formatQueueDate(value); }
  public total(lane: QueueLane): number { return this.snapshot().items.filter((item) => QueuePresentation.lane(item) === lane).length; }
  public clearSearch(): void { this.search.set(''); }
  public resumeBudgetBlocked(item: QueueItem): boolean {
    const run = this.detail()?.run;
    return !!run && run.id === item.id && !!RunBudget.reason(run, this.now(), run.stage < run.settings.pipeline.length);
  }
  public readonly replacement = signal<{ runId: string; options: { id: string; label: string; model: string; catalog: ModelCatalogInput }[] } | null>(null);
  public replacementProfileId = '';
  public replacementModel = '';
  public readonly replacementModels = signal<ModelOption[]>([]);
  public readonly replacementLoading = signal(false);
  public readonly replacementError = signal('');
  public chooseReplacement(run: AgentRun): void {
    const role = run.settings.agents.find(agent => agent.id === run.settings.pipeline[run.stage])?.role;
    this.replacementProfileId = '';
    this.http.get<AutomationSettings>('/api/automation/settings').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: settings => {
        const options = settings.agents.filter(agent => agent.role === role).flatMap(agent => {
          const connection = settings.connections.find(entry => entry.id === agent.connectionId);
          return connection ? [{ id: agent.id, label: `${agentProfileName(agent, settings.agents)} · ${connection.label} · ${agent.model}`, model: agent.model,
            catalog: { runner: agent.runner, connection } }] : [];
        });
        this.replacement.set({ runId: run.id, options });
        if (options.length === 1) this.loadReplacementModels(options[0].id);
      },
      error: error => this.error.set(this.message(error)),
    });
  }
  public loadReplacementModels(id: string): void {
    const choice = this.replacement();
    const option = choice?.options.find(entry => entry.id === id);
    if (!option || this.replacementLoading()) return;
    this.replacementProfileId = id;
    this.replacementModel = option.model;
    this.replacementModels.set([{ id: option.model, label: option.model }]);
    this.replacementError.set('');
    this.replacementLoading.set(true);
    this.awaitProject(this.http.post<ProjectRequest>('/api/automation/project-requests', { action: ProjectAction.Models, path: '', catalog: option.catalog })).pipe(
      finalize(() => this.replacementLoading.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: result => {
        if (this.replacement() !== choice) return;
        if (result.status === ProjectRequestStatus.Failed) {
          this.replacementError.set(result.error ?? 'Не удалось загрузить модели.');
          return;
        }
        const models = result.result?.models ?? [];
        this.replacementModels.set(models.some(model => model.id === option.model)
          ? models : [{ id: option.model, label: option.model }, ...models]);
      },
      error: error => { if (this.replacement() === choice) this.replacementError.set(this.message(error)); },
    });
  }
  private awaitProject(request: Observable<ProjectRequest>, timeoutMs: number = PROJECT_LIMITS.requestMs) {
    return request.pipe(switchMap(created => timer(0, PROJECT_LIMITS.pollMs).pipe(
      exhaustMap(() => this.http.get<ProjectRequest>(`/api/automation/project-requests/${created.id}`)),
      filter(result => result.status === ProjectRequestStatus.Completed || result.status === ProjectRequestStatus.Failed),
      take(1),
    )), timeout(timeoutMs + PROJECT_LIMITS.pollMs));
  }
  public readonly runDiff = signal<{ id: string; wholeRun: boolean; loading?: boolean; result?: ProjectDiff; error?: string } | null>(null);
  private loadRunDiff(id: string, wholeRun: boolean): void {
    const pending = { id, wholeRun, loading: true };
    this.runDiff.set(pending);
    this.awaitProject(this.http.post<ProjectRequest>(`/api/automation/runs/${id}/diff`, { wholeRun }))
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: reply => {
          if (this.runDiff() !== pending) return;
          this.runDiff.set({ id, wholeRun, result: reply.result?.diff, error: reply.error });
        },
        error: error => { if (this.runDiff() === pending) this.runDiff.set({ id, wholeRun, error: this.message(error) }); },
      });
  }
  public resumeWithReplacement(run: AgentRun): void {
    if (this.busy() || !this.replacementProfileId || !this.replacementModel || this.replacement()?.runId !== run.id) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post(`/api/automation/runs/${run.id}/resume`, { replacementProfileId: this.replacementProfileId, replacementModel: this.replacementModel })
      .pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.replacement.set(null); this.refresh.next(); },
        error: error => this.error.set(this.message(error)),
      });
  }
  public health(item: QueueItem): string { return QueuePresentation.health(item, this.now(), this.snapshot().host); }
  public role(role: string): string { return ROLE_OPTIONS.find((entry) => entry.value === role)?.label ?? role; }
  public currentRole(item: QueueItem): string { return item.status === RunStatus.Integrating ? 'Интеграция' : item.phase === 'waiting-slot' ? 'Ожидание слота' : this.role(item.pipeline.at(item.stage)?.role ?? ''); }
  public duration(at: string | undefined): string { return at ? `${Math.max(0, Math.floor((this.now() - Date.parse(at)) / 1000))} с` : 'нет данных'; }
  public progress(text: string): string { return RunProgressText.format(text); }
  public ngOnInit(): void {
    this.applyRoute();
    this.router.events.pipe(filter(event => event instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyRoute());
    this.destroyRef.onDestroy(() => this.closeTask());
  }
  private applyRoute(): void {
    const { paramMap, queryParamMap } = this.route.snapshot;
    const requestedView = paramMap.get('view');
    const view = requestedView === 'history' || requestedView === 'metrics' ? requestedView : 'queue';
    const task = view === 'history' ? queryParamMap.get('taskId') ?? '' : '';
    const linkedWorkspace = queryParamMap.get('workspace');
    const run = view === 'metrics' || (linkedWorkspace && linkedWorkspace !== this.workspace.current()) ? null : queryParamMap.get('run');
    const event = Number(queryParamMap.get('eventId'));
    const eventId = run && Number.isSafeInteger(event) && event > 0 ? event : null;
    const page = queryParamMap.get('panel');
    const runPage = run && (page === 'diagnosis' || page === 'commit-diff' || page === 'branch-diff') ? page : null;
    const viewChanged = this.view() !== view || this.historyTask() !== task;
    if (viewChanged || this.routedRun !== run) {
      if (run !== this.selectedId()) this.budgetEditing.set(false);
      this.closeTask();
      this.selectedId.set(run);
      this.selectedCache.set(undefined);
      this.confirmation.set(null);
      this.error.set('');
    }
    if (viewChanged) {
      this.activeLaneFilter.set('all');
      this.search.set('');
      this.pollError.set('');
    }
    if ((viewChanged || this.routedRun !== run) && window.matchMedia('(max-width: 768px)').matches) {
      this.leftSidebarOpen.set(!run);
    }
    this.view.set(view);
    this.historyTask.set(task);
    if (eventId !== this.sourceEventId() || run !== this.routedRun) {
      this.evidenceExpanded.set(false);
      if (eventId) this.leftSidebarOpen.set(false);
    }
    this.routedRun = run;
    this.sourceEventId.set(eventId);
    const occurrence = this.selectedOccurrence();
    if (occurrence && (occurrence.runId !== run || occurrence.eventId !== eventId)) this.selectedOccurrence.set(null);
    this.showDetails.set(!!run && queryParamMap.get('details') === '1');
    this.runPage.set(runPage);
    if (run && (runPage === 'commit-diff' || runPage === 'branch-diff')) {
      const wholeRun = runPage === 'branch-diff';
      const diff = this.runDiff();
      if (diff?.id !== run || diff.wholeRun !== wholeRun) this.loadRunDiff(run, wholeRun);
    } else {
      this.runDiff.set(null);
    }
  }
  public navigate(view: RunsView, run: string | null = null, taskId = '', eventId: number | null = null, details = false, panel: RunPage | null = null): void {
    void this.router.navigate(['/automation/runs', view], {
      queryParams: { run, taskId: taskId || null, eventId, workspace: run ? this.workspace.current() : null, details: details ? 1 : null, panel },
    });
  }
  public select(id: string): void { this.navigate(this.view(), id, this.historyTask()); }
  public viewMetrics(): void { this.navigate('metrics'); }
  public inspectOccurrence(occurrence: ImprovementOccurrence): void {
    this.selectedOccurrence.set(occurrence);
    this.navigate('history', occurrence.runId, '', occurrence.eventId);
  }
  public inspectRun(visible: boolean): void {
    const id = this.selectedId();
    if (id) this.navigate(this.view(), id, this.historyTask(), this.sourceEventId(), visible);
  }
  public openRunPage(id: string, panel: RunPage | null): void {
    this.navigate(this.view(), id, this.historyTask(), this.sourceEventId(), this.showDetails(), panel);
  }
  public configure(): void { void this.router.navigate(['/automation/settings/worker']); }
  public async openTask(context: { taskId: string; runId: string }): Promise<void> {
    this.store.closeCard();
    this.taskContext.set(context);
    await this.store.openCard(context.taskId);
    if (this.taskContext() === context && !this.store.openTask()) this.taskContext.set(null);
  }
  public closeTask(): void {
    if (!this.taskContext()) return;
    this.taskContext.set(null);
    this.store.closeCard();
  }
  public toggleLeftSidebar(): void { this.leftSidebarOpen.update(v => !v); }
  private loadInspectorWidth(): number {
    try {
      const saved = Number(localStorage.getItem('sat-queue-inspector-width'));
      if (saved && !isNaN(saved) && saved >= 380 && saved <= 960) return saved;
    } catch {}
    return 560;
  }
  public onInspectorResizeStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = this.inspectorWidth();
    this.isResizingInspector.set(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    const onMouseMove = (moveEvent: MouseEvent): void => {
      const deltaX = startX - moveEvent.clientX;
      const minWidth = 380;
      const leftWidth = this.leftSidebarOpen() ? 360 : 44;
      const minCenterWidth = 460;
      const maxAllowed = Math.max(minWidth, window.innerWidth - leftWidth - minCenterWidth);
      const maxWidth = Math.min(880, maxAllowed);
      this.inspectorWidth.set(Math.min(maxWidth, Math.max(minWidth, startWidth + deltaX)));
    };
    const onMouseUp = (): void => {
      this.isResizingInspector.set(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      try {
        localStorage.setItem('sat-queue-inspector-width', String(this.inspectorWidth()));
      } catch {}
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }
  public toggleInspectorWide(): void {
    const current = this.inspectorWidth();
    if (current > 660) {
      this.inspectorWidth.set(560);
    } else {
      const leftWidth = this.leftSidebarOpen() ? 360 : 44;
      const maxAvailable = Math.max(480, window.innerWidth - leftWidth - 500);
      const wide = Math.min(840, Math.max(640, maxAvailable));
      this.inspectorWidth.set(wide);
    }
    try {
      localStorage.setItem('sat-queue-inspector-width', String(this.inspectorWidth()));
    } catch {}
  }
  public checkOutcome(check: CheckEvidence): string {
    switch (check.outcome.kind) {
      case 'exit': return `Код выхода ${check.outcome.code}`;
      case 'launch_error': return 'Ошибка запуска процесса';
      case 'cancelled': return 'Отменено пользователем';
      case 'unknown': return 'Исход неизвестен';
    }
  }
  public filteredLanes() { return this.activeLaneFilter() === 'all' ? this.visibleLanes() : this.visibleLanes().filter(lane => lane.id === this.activeLaneFilter()); }
  public totalActive(): number { return this.items('queued').length + this.items('running').length; }
  public viewHistory(taskId = ''): void { this.navigate('history', taskId ? this.selectedId() : null, taskId); }
  public visibleLanes() {
    return this.historyMode()
      ? HISTORY_LANES.map(id => this.lanes.find(lane => lane.id === id)!)
      : this.lanes.filter(lane => lane.id === 'queued' || lane.id === 'running');
  }
  public manage(item: QueueItem): boolean { return !['queued', 'running', 'integrating', 'waiting'].includes(item.status); }
  public requestConfirmation(action: 'cleanup' | 'delete'): void { this.confirmation.set(action); this.discard = false; }
  public confirm(item: QueueItem): void {
    const action = this.confirmation(); if (!action || this.busy()) return;
    this.busy.set(true); this.error.set('');
    const body = action === 'delete' ? { force: this.discard || item.cleanup?.state === 'failed' } : { discard: this.discard };
    this.http.post(`/api/automation/runs/${item.id}/${action}`, body).pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.confirmation.set(null); if (action === 'delete') this.clearRun(); this.refresh.next(); void this.store.refresh(true); },
      error: (error: unknown) => this.error.set(this.message(error)),
    });
  }
  constructor() {
    let focusedEvidence: string | undefined;
    afterRenderEffect(() => {
      const occurrence = this.displayedOccurrence();
      const key = occurrence ? `${occurrence.runId}:${occurrence.eventId}` : undefined;
      if (key && key !== focusedEvidence) {
        const heading = this.element.nativeElement.querySelector<HTMLElement>('#evidence-heading');
        if (!heading) return;
        heading.closest('.queue-main')?.scrollTo(0, 0);
        heading.focus({ preventScroll: true });
      }
      focusedEvidence = key;
    });
    effect(() => {
      const items = this.snapshot().items;
      if (!this.metricsMode() && !this.selectedId() && items.length > 0) {
        const first = this.historyMode()
          ? HISTORY_LANES.map(lane => this.items(lane)[0]).find(Boolean)
          : items.find(item => QueuePresentation.lane(item) === 'running') ?? items[0];
        if (first) {
          this.selectedId.set(first.id);
          this.selectedCache.set(first);
        }
      }
    });
  }
  private clearRun(): void {
    this.selectedId.set(null);
    this.selectedCache.set(undefined);
    if (this.routedRun) this.navigate(this.view(), null, this.historyTask());
  }
  public refreshRun(): void { this.refresh.next(); }
  public canResumeFromCard(id: string): boolean {
    const item = this.selected();
    return !!item && item.id === id && item.canResume && !this.resumeBudgetBlocked(item);
  }
  public resumeFromCard(id: string): void {
    const item = this.selected();
    if (item && this.canResumeFromCard(id)) this.action(item, RunAction.Resume, false, () => this.closeTask());
  }
  public action(item: QueueItem, action: RunAction, refreshChecks = false, onSuccess?: () => void): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    this.http.post<{ run?: AgentRun }>(`/api/automation/runs/${item.id}/${action}`, refreshChecks ? { refreshChecks: true } : {}).pipe(
      tap((result) => {
        if (result.run && result.run.id !== item.id && this.selectedId() === item.id) this.select(result.run.id);
        this.refresh.next(); void this.store.refresh(true); onSuccess?.();
      }),
      catchError((error: unknown) => { this.error.set(this.message(error)); return EMPTY; }),
      finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }
  public canRetryCurrent(item: QueueItem): boolean {
    const role = item.pipeline[item.stage]?.role;
    return RESUMABLE_RUN_STATUSES.includes(item.status) && !!role && EVIDENCE_AGENT_ROLES.includes(role);
  }
  public canAcceptManually(item: QueueItem): boolean {
    const run = this.detail()?.run;
    return RESUMABLE_RUN_STATUSES.includes(item.status) && !!run && run.id === item.id && !!run.commitSha && !!run.checkout && !run.cleanup;
  }
  public acceptManually(item: QueueItem): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    this.http.post(`/api/automation/runs/${item.id}/accept-manually`, {}).pipe(
      finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => {
        this.notice.set('Результат принят вручную. Запуск завершён, журнал и замечания агентов сохранены.');
        this.refresh.next(); void this.store.refresh(true);
      },
      error: error => this.error.set(this.message(error)),
    });
  }
  public retryCurrent(item: QueueItem): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    this.http.post(`/api/automation/runs/${item.id}/resume`, { retryCurrent: true }).pipe(
      finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => { this.notice.set('Текущая проверка поставлена в очередь.'); this.refresh.next(); void this.store.refresh(true); },
      error: error => this.error.set(this.message(error)),
    });
  }
  public previewPatch(item: QueueItem, rollback: boolean): void {
    if (this.busy()) return;
    const deploy = this.deployPreviewPatch;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    this.awaitProject(this.http.post<ProjectRequest>(`/api/automation/runs/${item.id}/preview-patch`, { rollback, deploy }),
      deploy ? PROJECT_LIMITS.deploymentMs : PROJECT_LIMITS.requestMs).pipe(
      finalize(() => { this.busy.set(false); this.refresh.next(); }), takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: result => {
        if (result.status === ProjectRequestStatus.Failed) { this.error.set(result.error ?? 'Операция с патчем завершилась ошибкой.'); return; }
        const message = rollback ? 'Патч снят. Можно продолжать запуск.' : 'Изменения применены для проверки в базовой рабочей копии.';
        this.notice.set(message + (deploy && !result.result?.deploymentError ? ' Пост-операции выполнены.' : ' Пересоберите приложение для проверки.'));
        if (result.result?.deploymentError) this.error.set(result.result.deploymentError);
        void this.store.refresh(true);
      },
      error: error => this.error.set(this.message(error)),
    });
  }
  public dequeue(item: QueueItem): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    this.http.post('/api/automation/runs/' + item.id + '/dequeue', {}).pipe(
      tap(() => { this.notice.set('Убрано из очереди. Задача и журнал сохранены.'); this.refresh.next(); void this.store.refresh(true); }),
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
      next: () => { this.archived.set((this.archived() ?? []).filter((run) => run.id !== id)); this.refresh.next(); void this.store.refresh(true); },
      error: (error: unknown) => this.error.set(this.message(error)),
    });
  }
  public hide(item: QueueItem): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.http.post('/api/automation/runs/' + item.id + '/hide', {}).pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.refresh.next(); if (this.selectedId() === item.id) this.clearRun(); void this.store.refresh(true); },
      error: (error: unknown) => { this.error.set(this.message(error)); this.refresh.next(); },
    });
  }

  public diagnose(item: QueueItem): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post<{ fix: ProposedFix }>(`/api/automation/runs/${item.id}/fix/diagnose`, {})
      .pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ fix }) => {
          this.diagnosed.set({ runId: item.id, fix });
          if (this.selectedId() === item.id) this.openRunPage(item.id, 'diagnosis');
          this.refresh.next();
        },
        error: (err) => this.error.set(this.message(err)),
      });
  }

  public applyFix(): void {
    const id = this.selectedId();
    if (!id) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post<{ run: AgentRun }>(`/api/automation/runs/${id}/fix/apply`, {})
      .pipe(switchMap(result => result.run.status === RunStatus.Queued ? of(result)
        : this.http.post<{ run: AgentRun }>(`/api/automation/runs/${id}/resume`, {})),
        finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.closeDiagnosis(id);
          this.notice.set('Запуск поставлен в очередь.');
          this.refresh.next();
        },
        error: (err) => this.error.set(this.message(err)),
      });
  }

  public discardFix(): void {
    const id = this.selectedId();
    if (!id) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post<{ run: AgentRun }>(`/api/automation/runs/${id}/fix/discard`, {})
      .pipe(finalize(() => this.busy.set(false)), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.closeDiagnosis(id);
          this.notice.set('Предложение диагностики отклонено.');
          this.refresh.next();
        },
        error: (err) => this.error.set(this.message(err)),
      });
  }

  private closeDiagnosis(id: string): void {
    this.diagnosed.set(null);
    if (id === this.selectedId() && this.runPage() === 'diagnosis') this.openRunPage(id, null);
  }
}
