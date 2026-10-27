import { ChangeDetectorRef, Component, DestroyRef, ElementRef, EventEmitter, Input, OnInit, Output, ViewChild, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { exhaustMap, filter, firstValueFrom, last, lastValueFrom, switchMap, takeWhile, timeout, timer } from 'rxjs';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TabsModule } from 'primeng/tabs';
import { AccordionModule } from 'primeng/accordion';
import { AUTOMATION_TABS, AutomationTab } from './automation-panel.types';
import { AGENT_ROLES, RUNNER_IDS, DEFAULT_AUTOMATION_SETTINGS, PROVIDER_KINDS, REASONING_EFFORTS, MERGE_POLICIES,
  AUTOMATION_LIMITS, AUTOMATION_TIMING,
  DEFAULT_CHECK_COMMAND, DEFAULT_SETUP_COMMAND, ProviderKind, RunnerId, AgentRole,
  type AgentRun, type AutomationSettings, type CheckCommand, type AgentProfile } from '../../../../../shared/automation/contracts';
import { ProjectAction, ProjectRequestStatus, PROJECT_LIMITS, SETUP_PRESETS, CHECK_PRESETS, WorkerPlatform,
  type ProjectInput, type ProjectRequest, type ProjectResult, type HostStatus, type CommandPreset } from '../../../../../shared/automation/project';
import { CONNECTION_PRESETS, PROVIDER_OPTIONS, ROLE_OPTIONS, STANDARD_TEAM_ROLES, type ConnectionPreset } from '../../../../../shared/automation/presets';
import type { TaskSummary } from '../../models/tracker.models';
import { WorkspaceService } from '../../services/workspace.service';
import { WorkerLaunchCommand, DEFAULT_TRACKER_CONTAINER } from '../../../../../shared/automation/launch-command';
import { AgentTeamProfiles, DEFAULT_ROLE_INSTRUCTIONS } from '../../../../../shared/automation/team-profiles';
import { TaskAutomationReadiness, TASK_STATUS_TITLES, TASK_SELECTION_LIMIT, type TaskReadiness, type TaskLaunchCandidate } from '../../../../../shared/automation/task-readiness';
import { ModelCatalogKey, type ModelOption } from '../../../../../shared/automation/model-catalog';

@Component({ selector: 'sat-automation-panel', standalone: true,
  imports: [FormsModule, ReactiveFormsModule, SelectModule, ButtonModule, InputTextModule, TabsModule, AccordionModule],
  templateUrl: './automation-panel.component.html', styleUrl: './automation-panel.component.scss' })
export class AutomationPanelComponent implements OnInit {
  @Output() public readonly openQueue = new EventEmitter<string | null>();
  public readonly tabs = AUTOMATION_TABS;
  public readonly tab = AutomationTab;
  public activeTab: string | number = AutomationTab.Project;
  @Input() public initialMessage = '';
  @Input() public set initialTaskId(id: string | null) {
    if (id) { this.taskControl.setValue(id); this.activeTab = AutomationTab.Launch; }
  }
  private availableTasks: readonly TaskSummary[] = [];
  private latestTasks: readonly TaskLaunchCandidate[] | null = null;
  public readonly taskSelectionLimit = TASK_SELECTION_LIMIT;
  public get taskListLimited(): boolean { return (this.latestTasks?.length ?? 0) >= TASK_SELECTION_LIMIT; }
  private taskOptionsCache: { label: string; value: string; disabled: boolean; readiness: TaskReadiness; title: string }[] = [];
  private taskOptionsSignature = '';
  @Input() public set tasks(value: readonly TaskSummary[]) {
    this.availableTasks = value;
  }
  public readonly taskControl = new FormControl<string | null>(null);
  public get selectedTask(): string | null { return this.taskControl.value; }
  public get taskOptions() {
    const options = (this.latestTasks ?? this.availableTasks).map((task) => {
      const readiness = TaskAutomationReadiness.evaluate(task, this.settings, this.activeTaskIds.includes(task.id));
      return { value: task.id, title: task.title, label: `${task.id} · ${task.title} · ${TASK_STATUS_TITLES[task.status]} · ${readiness.summary}`,
        disabled: !readiness.canStart, readiness };
    });
    const signature = JSON.stringify(options);
    if (signature !== this.taskOptionsSignature) { this.taskOptionsSignature = signature; this.taskOptionsCache = options; }
    return this.taskOptionsCache;
  }
  public get selectedEligibility(): TaskReadiness | undefined { return this.taskOptions.find((option) => option.value === this.selectedTask)?.readiness; }
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly workspace = inject(WorkspaceService);
  @ViewChild('commandText') private commandText?: ElementRef<HTMLTextAreaElement>;
  public settings = structuredClone(DEFAULT_AUTOMATION_SETTINGS);
  private readonly modelCatalogs = new Map<string, ModelOption[]>();
  private readonly modelMessages = new Map<string, string>();
  private readonly modelControls = new Map<string, FormControl<string>>();
  private readonly modelOptionsCache = new Map<string, { signature: string; options: ModelOption[] }>();
  public readonly manualModels = new Set<string>();
  public modelControl(agent: AgentProfile): FormControl<string> {
    let control = this.modelControls.get(agent.id);
    if (!control) {
      control = new FormControl(agent.model, { nonNullable: true }); this.modelControls.set(agent.id, control);
      const agentId = agent.id;
      control.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((value) => {
        const current = this.settings.agents.find((entry) => entry.id === agentId);
        if (current) current.model = value;
        this.changeDetector.markForCheck();
      });
    }
    if (control.value !== agent.model) control.setValue(agent.model, { emitEvent: false });
    return control;
  }
  private modelKey(agent: AgentProfile): string {
    const connection = this.settings.connections.find((entry) => entry.id === agent.connectionId);
    return connection ? ModelCatalogKey.create({ runner: agent.runner, connection }) : '';
  }
  public modelOptions(agent: AgentProfile): ModelOption[] {
    const key = this.modelKey(agent); const models = this.modelCatalogs.get(key) ?? [];
    const signature = JSON.stringify([key, models, agent.model]);
    let cached = this.modelOptionsCache.get(agent.id);
    if (cached?.signature !== signature) {
      cached = { signature, options: agent.model && !models.some((m) => m.id === agent.model)
        ? [{ id: agent.model, label: `${agent.model} · вне загруженного списка` }, ...models] : models };
      this.modelOptionsCache.set(agent.id, cached);
    }
    return cached.options;
  }
  public modelMessage(agent: AgentProfile): string { return this.modelMessages.get(this.modelKey(agent)) ?? 'Нажмите «Обновить модели»: список придёт с компьютера worker.'; }
  public async loadModels(agent: AgentProfile): Promise<void> {
    const connection = this.settings.connections.find((entry) => entry.id === agent.connectionId);
    if (!connection || this.projectBusy) return;
    const key = this.modelKey(agent);
    this.modelMessages.set(key, 'Загрузка моделей с worker…');
    const result = await this.project({ action: ProjectAction.Models, path: '', catalog: { runner: agent.runner, connection: structuredClone(connection) } }, (result) => {
      if (!Array.isArray(result.models)) throw new Error('Worker не поддерживает каталог моделей. Перезапустите его новой командой из шага 1.');
      this.modelCatalogs.set(key, result.models);
      this.modelMessages.set(key, result.models.length ? `Доступно моделей: ${result.models.length}. Выберите модель в списке.` : 'Провайдер вернул пустой список. Проверьте модели на worker или укажите ID вручную.');
    });
    if (this.destroyed) return;
    if (!result) this.modelMessages.set(key, this.error || 'Не удалось получить модели. Повторите запрос или укажите ID вручную.');
    this.changeDetector.markForCheck();
  }
  public toggleManualModel(agent: AgentProfile): void {
    if (this.manualModels.has(agent.id)) this.manualModels.delete(agent.id); else this.manualModels.add(agent.id);
  }
  public runs: AgentRun[] = [];
  public selectedRun: string | null = null;
  public activeTaskIds: string[] = [];
  public startError = ''; public startNotice = ''; public starting = false;
  public submittedRun: AgentRun | null = null;
  public pollError = '';
  private polling = false;
  public error = ''; public notice = ''; public busy = false;
  public readonly roles = [...AGENT_ROLES];
  public readonly runners = [...RUNNER_IDS];
  public readonly providers = [...PROVIDER_KINDS];
  public readonly reasoningEfforts = [...REASONING_EFFORTS];
  public readonly mergePolicies = [...MERGE_POLICIES];
  public readonly dependencyModes = ['isolated', 'linked'];
  public readonly providerKind = ProviderKind;
  public readonly runnerId = RunnerId;
  public readonly limits = AUTOMATION_LIMITS;
  public readonly providerOptions = PROVIDER_OPTIONS;
  public readonly roleOptions = ROLE_OPTIONS;
  public readonly connectionPresets = CONNECTION_PRESETS;
  public readonly setupPresets = SETUP_PRESETS;
  public checkPresets: readonly CommandPreset[] = CHECK_PRESETS;
  public host: HostStatus = { online: false };
  public projectBusy = false;
  public browserOpen = false;
  public directory: ProjectResult | null = null;
  public branchOptions: string[] = [];
  public newBranch = '';
  public advancedCommands = false;
  public readonly workerPlatform = WorkerPlatform;
  public workerContainer = DEFAULT_TRACKER_CONTAINER;
  public showLaunchCommand = false;
  public launchNotice = '';
  public repairNotice = '';
  public pendingFolderPick = false;
  private readonly teamProfiles = new AgentTeamProfiles();
  private inspectedPath = '';
  public get launchCommand(): string {
    try { return WorkerLaunchCommand.create(this.workspace.current(), this.workerContainer); }
    catch { return ''; }
  }
  public async copyLaunchCommand(): Promise<void> {
    if (this.host.online) return;
    if (!this.launchCommand) { this.launchNotice = 'Проверьте имя Docker-контейнера.'; return; }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(this.launchCommand);
      if (this.destroyed) return;
      this.launchNotice = 'Команда скопирована. Вставьте её в PowerShell из любой папки и нажмите Enter.';
    } catch {
      if (this.destroyed) return;
      this.showLaunchCommand = true;
      this.launchNotice = 'Браузер запретил буфер обмена. Команда выделена ниже: нажмите Ctrl+C.';
      this.changeDetector.detectChanges();
      this.commandText?.nativeElement.focus(); this.commandText?.nativeElement.select();
    }
    this.changeDetector.markForCheck();
  }
  public setProjectPath(value: string): void { this.settings.repositoryPath = value; this.branchOptions = []; this.launchNotice = ''; }
  private destroyed = false;
  private connectionOptionsSignature = '';
  private connectionOptionsCache: { label: string; value: string }[] = [];
  public ngOnInit(): void {
    this.destroyRef.onDestroy(() => { this.destroyed = true; });
    this.taskControl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.startError = ''; this.changeDetector.markForCheck(); });
    void this.act(async () => {
      const prepared = this.teamProfiles.prepare(await firstValueFrom(this.http.get<AutomationSettings>('/api/automation/settings')));
      this.settings = prepared.settings;
      if (prepared.repaired) this.repairNotice = 'Исправлены совпадающие ID агентов в черновике. Проверьте порядок этапов и сохраните настройки.';
      await this.refresh();
    });
    timer(AUTOMATION_TIMING.pollMs, AUTOMATION_TIMING.pollMs).pipe(
      filter(() => !this.busy && !this.starting), exhaustMap(() => this.poll()), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }
  public addPresetConnection(id: ConnectionPreset): void {
    const preset = CONNECTION_PRESETS.find((entry) => entry.id === id)!;
    this.settings.connections.push({ ...structuredClone(preset.connection), id: crypto.randomUUID() });
    this.notice = `Подключение «${preset.label}» добавлено. Выберите его у нужных агентов.`;
  }
  public commandSelected(value: CheckCommand, setup: boolean): boolean {
    return (setup ? this.settings.setup : this.settings.checks).some((entry) => entry.command === value.command && this.json(entry.args) === this.json(value.args));
  }
  public toggleCommand(value: CheckCommand, setup: boolean): void {
    const list = setup ? this.settings.setup : this.settings.checks;
    const index = list.findIndex((entry) => entry.command === value.command && this.json(entry.args) === this.json(value.args));
    if (index >= 0) list.splice(index, 1); else list.push(structuredClone(value));
  }
  public commandLabel(value: CheckCommand): string { return [value.command, ...value.args].join(' '); }
  public async pickFolder(): Promise<void> {
    if (!this.host.online) {
      this.pendingFolderPick = true;
      await this.copyLaunchCommand();
      return;
    }
    if (this.host.platform !== WorkerPlatform.Windows) { this.browse(''); return; }
    this.notice = 'Выберите папку в системном окне на компьютере worker (ожидание до минуты).';
    const result = await this.project({ action: ProjectAction.PickFolder, path: this.settings.repositoryPath }, (result) => {
      if (result.cancelled) { this.notice = 'Выбор папки отменён. Путь не изменён.'; return; }
      this.setProjectPath(result.path);
    });
    if (result && !result.cancelled && !this.destroyed) this.inspect();
  }
  public readProjectIfNeeded(event?: FocusEvent): void {
    if (event?.relatedTarget instanceof Element && event.relatedTarget.closest('[data-project-picker]')) return;
    if (this.host.online && !this.projectBusy && this.settings.repositoryPath.trim() && this.inspectedPath !== this.settings.repositoryPath) this.inspect();
  }
  public browse(path = ''): void { void this.project({ action: ProjectAction.Browse, path }, (result) => { this.directory = result; this.browserOpen = true; }); }
  public inspect(): void { void this.project({ action: ProjectAction.Inspect, path: this.settings.repositoryPath }, (result) => this.applyProject(result)); }
  public chooseDirectory(): void { if (this.directory) { this.setProjectPath(this.directory.path); this.browserOpen = false; this.inspect(); } }
  public createBranch(): void {
    void this.project({ action: ProjectAction.CreateBranch, path: this.settings.repositoryPath, baseBranch: this.settings.baseBranch, newBranch: this.newBranch }, (result) => {
      this.applyProject(result); this.settings.baseBranch = this.newBranch; this.newBranch = ''; this.notice = 'Ветка создана без переключения рабочей папки. Сохраните настройки.';
    });
  }
  private applyProject(result: ProjectResult): void {
    this.inspectedPath = result.path;
    this.settings.repositoryPath = result.path; this.branchOptions = result.branches ?? [];
    if (!this.branchOptions.includes(this.settings.baseBranch)) this.settings.baseBranch = result.currentBranch || this.branchOptions[0] || '';
    this.checkPresets = (result.scripts ?? []).map((script) => ({ id: script, label: script,
      description: `npm run ${script}`, value: { command: 'npm', args: script === 'test' ? ['test'] : ['run', script] } }));
    this.notice = 'Проект прочитан на worker. Выберите ветку и команды из package.json.';
  }
  private async project(input: ProjectInput, apply: (result: ProjectResult) => void): Promise<ProjectResult | undefined> {
    if (this.projectBusy) return;
    this.projectBusy = true; this.error = ''; this.changeDetector.markForCheck();
    try {
      const request = await lastValueFrom(this.http.post<ProjectRequest>('/api/automation/project-requests', input).pipe(
        switchMap((created) => timer(PROJECT_LIMITS.pollMs, PROJECT_LIMITS.pollMs).pipe(
          exhaustMap(() => this.http.get<ProjectRequest>(`/api/automation/project-requests/${created.id}`)),
        )),
        takeWhile((value) => value.status === ProjectRequestStatus.Queued || value.status === ProjectRequestStatus.Running, true),
        last(), timeout({ first: PROJECT_LIMITS.requestMs + PROJECT_LIMITS.pollMs }), takeUntilDestroyed(this.destroyRef),
      ));
      if (this.destroyed) return;
      if (request.error || !request.result) throw new Error(request.error || 'Worker не вернул результат.');
      apply(request.result);
      return request.result;
    } catch (error) { if (!this.destroyed) this.error = this.errorMessage(error); }
    finally { this.projectBusy = false; if (!this.destroyed) this.changeDetector.markForCheck(); }
  }
  public get connectionOptions() {
    const signature = JSON.stringify(this.settings.connections.map(({ id, label }) => ({ id, label })));
    if (signature !== this.connectionOptionsSignature) {
      this.connectionOptionsSignature = signature;
      this.connectionOptionsCache = this.settings.connections.map((entry) => ({ label: entry.label || entry.id, value: entry.id }));
    }
    return this.connectionOptionsCache;
  }
  public stageNumber(run: AgentRun): number { return Math.min(run.stage + 1, run.settings.pipeline.length); }
  public addConnection(): void { this.settings.connections.push({ id: `connection-${crypto.randomUUID()}`, label: 'Подключение', kind: ProviderKind.Native, supportsImages: false }); }
  public addAgent(role: AgentRole = AgentRole.Developer): void {
    const agent = this.teamProfiles.create(role, this.settings.connections[0]?.id ?? '');
    this.settings.agents.push(agent); this.settings.pipeline.push(agent.id);
    this.selectConnection(agent);
  }
  public addStandardTeam(): void {
    if (this.settings.agents.length) return;
    for (const role of STANDARD_TEAM_ROLES) this.addAgent(role);
    this.notice = 'Четыре роли добавлены. Укажите модель каждой роли; подключение можно менять отдельно.';
  }
  public selectConnection(agent: AgentProfile): void {
    const connection = this.settings.connections.find((entry) => entry.id === agent.connectionId);
    if (!connection) return;
    if (connection.kind !== ProviderKind.Native) { agent.runner = RunnerId.ModelApi; return; }
    const preset = CONNECTION_PRESETS.find((entry) => entry.connection.label === connection.label && entry.connection.kind === connection.kind);
    if (preset) agent.runner = preset.runner;
    else if (agent.runner === RunnerId.ModelApi) agent.runner = RunnerId.Codex;
  }
  public removeAgent(id: string): void { this.settings.agents = this.settings.agents.filter((entry) => entry.id !== id); this.settings.pipeline = this.settings.pipeline.filter((entry) => entry !== id); }
  public move(index: number, direction: number): void {
    const target = index + direction;
    if (target < 0 || target >= this.settings.pipeline.length) return;
    [this.settings.pipeline[index], this.settings.pipeline[target]] = [this.settings.pipeline[target], this.settings.pipeline[index]];
  }
  public roleLabel(role: AgentRole): string { return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role; }
  public changeRole(agent: AgentProfile, role: AgentRole): void { this.teamProfiles.changeRole(agent, role); }
  public resetInstructions(agent: AgentProfile): void { agent.instructions = DEFAULT_ROLE_INSTRUCTIONS[agent.role]; }
  public agentLabel(id: string): string { const agent = this.settings.agents.find((entry) => entry.id === id); return agent ? `${this.roleLabel(agent.role)} · ${agent.runner} · ${agent.model || 'выберите модель'}` : id; }
  public save(): void { void this.act(async () => { this.settings = await firstValueFrom(this.http.post<AutomationSettings>('/api/automation/settings', this.settings)); this.repairNotice = ''; this.notice = 'Настройки пространства сохранены.'; }); }
  public start(): void {
    if (this.starting) return;
    this.startError = ''; this.startNotice = '';
    if (!this.selectedTask) { this.startError = 'Выберите задачу для запуска.'; return; }
    if (!this.selectedEligibility?.canStart) { this.startError = this.selectedEligibility?.reasons.join(' ') || 'Задача больше не доступна для запуска. Обновите список.'; return; }
    this.starting = true;
    const taskId = this.selectedTask; const settings = structuredClone(this.settings);
    void (async () => {
      try {
        const { run } = await firstValueFrom(this.http.post<{ run: AgentRun }>('/api/automation/runs', { taskId, settings }));
        if (this.destroyed) return;
        this.submittedRun = run; this.selectedRun = run.id; this.repairNotice = '';
        this.startNotice = this.host.online ? `Запуск ${run.id} создан для ${taskId}. Ожидает захвата worker.`
          : `Задача ${taskId} поставлена в очередь. Worker отключён — выполнение ещё не началось. Подключите компьютер в шаге 1.`;
        await this.poll();
        if (!this.destroyed) this.openQueue.emit(run.id);
      } catch (error) { if (!this.destroyed) this.startError = `Ошибка запуска: ${this.errorMessage(error)}`; }
      finally { this.starting = false; this.changeDetector.markForCheck(); }
    })();
  }
  public addCheck(): void { this.settings.checks.push(structuredClone(DEFAULT_CHECK_COMMAND)); }
  public addSetup(): void { this.settings.setup.push(structuredClone(DEFAULT_SETUP_COMMAND)); }
  public setArgs(index: number, value: string, custom = false, setup = false): void {
    try { const args: unknown = JSON.parse(value); if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) throw new Error(); if (custom) this.settings.agents[index].args = args; else (setup ? this.settings.setup : this.settings.checks)[index].args = args; this.error = ''; }
    catch { this.error = 'Аргументы: нужен JSON-массив строк.'; }
  }
  public json(value: unknown): string { return JSON.stringify(value); }
  public setArtifacts(value: string): void { this.settings.artifactPaths = value.split('\n').map((entry) => entry.trim()).filter(Boolean); }
  private async refresh(): Promise<void> {
    this.host = await firstValueFrom(this.http.get<HostStatus>('/api/automation/host'));
    if (!this.destroyed && this.host.online && this.pendingFolderPick && !this.projectBusy) {
      this.pendingFolderPick = false;
      void this.pickFolder();
    }
    const response = await firstValueFrom(this.http.get<{ runs: AgentRun[]; activeTaskIds: string[]; tasks: TaskLaunchCandidate[] }>('/api/automation/runs'));
    this.runs = response.runs; this.activeTaskIds = response.activeTaskIds ?? [];
    if (response.tasks) this.latestTasks = response.tasks;
    if (this.submittedRun) this.submittedRun = this.runs.find((run) => run.id === this.submittedRun!.id) ?? this.submittedRun;
  }
  private async poll(): Promise<void> {
    if (this.polling || this.destroyed) return;
    this.polling = true;
    try { await this.refresh(); this.pollError = ''; }
    catch (error) { if (!this.destroyed) this.pollError = `Не удалось обновить состояние: ${this.errorMessage(error)}`; }
    finally { this.polling = false; this.changeDetector.markForCheck(); }
  }
  private errorMessage(error: unknown): string {
    const response = error as { error?: { error?: { message?: string } }; message?: string };
    return response.error?.error?.message ?? response.message ?? 'Не удалось выполнить операцию.';
  }
  private async act(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    try { await action(); this.error = ''; }
    catch (error: unknown) { this.error = this.errorMessage(error); }
    finally { this.busy = false; this.changeDetector.markForCheck(); }
  }
}
