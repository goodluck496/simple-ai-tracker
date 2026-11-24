import { ChangeDetectorRef, Component, DestroyRef, ElementRef, Injector, OnInit, ViewChild, afterNextRender, inject } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { exhaustMap, filter, firstValueFrom, last, lastValueFrom, switchMap, takeWhile, tap, timeout, timer, TimeoutError } from 'rxjs';
import type { TreeNode } from 'primeng/api';
import { TreeModule } from 'primeng/tree';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { InputTextModule } from 'primeng/inputtext';
import { TabsModule } from 'primeng/tabs';
import { AccordionModule } from 'primeng/accordion';
import { DialogModule } from 'primeng/dialog';
import { MultiSelectModule } from 'primeng/multiselect';
import { TooltipModule } from 'primeng/tooltip';
import { PanelModule } from 'primeng/panel';
import { TextareaModule } from 'primeng/textarea';
import { MessageModule } from 'primeng/message';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { BATCH_TASK_LIMIT } from '../../../../../shared/automation/batch';
import { MCP_CATALOG } from '../../../../../shared/automation/mcp-catalog';
import { PipelinePolicy } from '../../../../../shared/automation/pipeline-policy';
import { AUTOMATION_TABS, AutomationTab } from './automation-panel.types';
import { PipelineFlowComponent } from './pipeline-flow.component';
import { SkillLibraryComponent } from './skill-library.component';
import { ProjectMcpComponent } from './project-mcp.component';
import type { SkillSummary } from '../../../../../shared/automation/skills';
import type { ProjectMcp } from '../../../../../shared/automation/project-mcp';
import { AGENT_ROLES, RUNNER_IDS, DEFAULT_AUTOMATION_SETTINGS, PROVIDER_KINDS, REASONING_EFFORTS, MERGE_POLICIES,
  AUTOMATION_LIMITS, AUTOMATION_TIMING,
  DEFAULT_SETUP_COMMAND, ProviderKind, RunnerId, AgentRole,
  type AgentRun, type AutomationSettings, type CheckCommand, type AgentProfile, type ModelConnection } from '../../../../../shared/automation/contracts';
import { ProjectAction, ProjectRequestStatus, PROJECT_LIMITS, SETUP_PRESETS, CHECK_PRESETS, WorkerPlatform, packageScript, pnpmInstall, projectCommand,
  type PackageManagerInfo, type ProjectPassport, type ProjectInput, type ProjectRequest, type ProjectResult, type HostStatus, type CommandPreset } from '../../../../../shared/automation/project';
import { CONNECTION_PRESETS, FULL_TEAM_ROLES, PROVIDER_OPTIONS, RUNNER_OPTIONS, ROLE_OPTIONS, STANDARD_TEAM_ROLES, type ConnectionPreset } from '../../../../../shared/automation/presets';
import type { TaskSummary } from '../../models/tracker.models';
import { TrackerStore } from '../../services/tracker-store.service';
import { TrackerApiService } from '../../services/tracker-api.service';
import { WorkspaceService } from '../../services/workspace.service';
import { WorkerLaunchCommand, DEFAULT_TRACKER_CONTAINER } from '../../../../../shared/automation/launch-command';
import { AGENT_PROFILE_NAME_LIMIT, agentProfileName, AgentTeamProfiles, DEFAULT_ROLE_INSTRUCTIONS } from '../../../../../shared/automation/team-profiles';
import { nativeConnectionRunner, stageAuditRunner } from '../../../../../shared/automation/stage-audit';
import { applyTeam, type BaseTeamState } from '../../../../../shared/automation/base-team';
import { TaskAutomationReadiness, TASK_STATUS_TITLES, TASK_SELECTION_LIMIT, type TaskReadiness, type TaskLaunchCandidate } from '../../../../../shared/automation/task-readiness';
import { ModelCatalogKey, type ModelOption } from '../../../../../shared/automation/model-catalog';

@Component({ selector: 'sat-automation-panel', standalone: true,
  imports: [NgTemplateOutlet, TreeModule, FormsModule, ReactiveFormsModule, SelectModule, ButtonModule, CheckboxModule, InputTextModule, TabsModule, AccordionModule, DialogModule, MultiSelectModule, TooltipModule, PanelModule, TextareaModule, MessageModule, ToggleSwitchModule, PipelineFlowComponent, SkillLibraryComponent, ProjectMcpComponent, CdkScrollable],
  templateUrl: './automation-panel.component.html', styleUrl: './automation-panel.component.scss' })
export class AutomationPanelComponent implements OnInit {
  public readonly mcpCatalog = MCP_CATALOG;
  public library: SkillSummary[] = [];
  public baseTeam?: BaseTeamState;
  public confirmPublish = false;
  public adoptingTeam = false;
  private readProjectTeam() {
    return firstValueFrom(this.http.get<{settings: AutomationSettings; base: BaseTeamState}>('/api/automation/project-team'));
  }
  public useBaseTeam(): void {
    if (!this.baseTeam?.team || this.settingsScope !== 'project') return;
    this.settings = applyTeam(this.settings, this.baseTeam.team);
    this.adoptingTeam = true;
    this.notice = 'Базовая команда загружена в черновик. Сохраните настройки проекта.';
  }
  public publishBaseTeam(): void {
    if (!this.baseTeam || this.settingsScope !== 'project') return;
    const revision = this.baseTeam.revision;
    this.confirmPublish = false;
    void this.act(async () => {
      await firstValueFrom(this.http.post('/api/automation/base-team', {revision, settings: this.settings}));
      this.baseTeam = (await this.readProjectTeam()).base;
      this.notice = 'Базовая команда сохранена для всех проектов.';
    });
  }
  private resourceCache?: {library:SkillSummary[]; bindings:AutomationSettings['skillBindings']; servers:AutomationSettings['mcpServers'];
    connected:SkillSummary[]; assignableMcp:ProjectMcp[]; skills:Map<AgentRole,string[]>; mcp:Map<AgentRole,string[]> };
  public get roleResources() {
    const bindings = this.settings.skillBindings, servers = this.settings.mcpServers;
    if (this.resourceCache?.library === this.library && this.resourceCache.bindings === bindings && this.resourceCache.servers === servers) return this.resourceCache;
    const skills = new Map<AgentRole,string[]>(), mcp = new Map<AgentRole,string[]>();
    for (const role of AGENT_ROLES) {
      skills.set(role, bindings?.filter(b => b.roles.includes(role)).map(b => b.skillId) ?? []);
      mcp.set(role, servers?.filter(s => s.roles?.includes(role)).map(s => s.name) ?? []);
    }
    return this.resourceCache = {library:this.library, bindings, servers, skills, mcp, assignableMcp:servers?.filter(s => s.tools.length) ?? [],
      connected:this.library.filter(s => bindings?.some(b => b.skillId === s.id))};
  }
  public assignSkills(role:AgentRole, ids:string[]): void {
    this.settings.skillBindings = this.settings.skillBindings?.map(b => ({...b,roles:this.assignedRoles(b.roles, role, ids.includes(b.skillId))}));
  }
  public assignMcp(role:AgentRole, names:string[]): void {
    this.settings.mcpServers = this.settings.mcpServers?.map(s => ({...s,roles:this.assignedRoles(s.roles ?? [], role, names.includes(s.name))}));
  }
  private assignedRoles(roles: AgentRole[], role: AgentRole, enabled: boolean): AgentRole[] {
    return enabled ? [...new Set([...roles,role])] : roles.filter(item => item !== role);
  }
  public readonly probeMcp = async (mcp: ProjectMcp) => {
    if (this.projectBusy) throw new Error('Воркер обрабатывает другой запрос. Повторите получение инструментов.');
    const result = await this.project({action:ProjectAction.ProbeMcp,path:mcp.url ? '' : this.settings.repositoryPath,mcp}, () => {});
    if (!result?.mcpTools) throw new Error(this.error || 'Воркер не вернул список инструментов.');
    return result.mcpTools;
  };
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly store = inject(TrackerStore);
  private readonly injector = inject(Injector);
  private routedTaskId: string | null = null;
  @ViewChild('scrollPane') private scrollPane?: ElementRef<HTMLElement>;
  @ViewChild('firstConnectionName') private firstConnectionName?: ElementRef<HTMLInputElement>;
  private newestConnectionId: string | null = null;
  public readonly profileNameLimit = AGENT_PROFILE_NAME_LIMIT;
  public readonly tabs = AUTOMATION_TABS;
  public readonly tab = AutomationTab;
  public activeTab: AutomationTab = AutomationTab.Team;
  public get sectionTitle(): string { return this.tabs.find(item => item.value === this.activeTab)!.label; }
  public sidebarCollapsed = window.matchMedia('(max-width: 700px)').matches;
  public toggleSidebar(): void { this.sidebarCollapsed = !this.sidebarCollapsed; }
  public selectTab(value: AutomationTab): void {
    this.navigateSettings(value, this.settingsScope);
    if (window.matchMedia('(max-width: 700px)').matches) this.sidebarCollapsed = true;
  }
  public openQueue(run: string | null): void {
    void this.router.navigate(['/automation/runs/queue'], {
      queryParams: run ? { run, workspace: this.workspace.current() } : undefined,
    });
  }
  private navigateSettings(section: AutomationTab, scope: 'project' | 'task', batch = this.batchMode): void {
    void this.router.navigate(['/automation/settings', section], {
      queryParams: { scope: scope === 'task' ? scope : null, taskId: this.selectedTask,
        workspace: this.selectedTask ? this.workspace.current() : null, batch: scope === 'project' && batch ? 1 : null },
    });
  }
  public changeBatchMode(batch: boolean): void {
    if (batch !== this.batchMode) this.navigateSettings(AutomationTab.Launch, 'project', batch);
  }
  public batchMode = false;
  public batchTaskIds: string[] = [];
  private batchRequest?: { signature: string; id: string };
  public readonly batchLimit = BATCH_TASK_LIMIT;
  public get batchRows() {
    return this.batchTaskIds.map(id => {
      const option = this.taskOptions.find(option => option.value === id);
      return { id, label: option?.title ?? id, reasons: option ? option.readiness.reasons : ['Задача недоступна в текущем списке.'] };
    });
  }
  public get batchBlocked(): boolean { return this.batchRows.some(row => row.reasons.length > 0); }
  public selectAvailableTasks(): void { this.batchTaskIds = this.taskOptions.filter(option => !option.disabled).slice(0, BATCH_TASK_LIMIT).map(option => option.value); }
  public removeBatchTask(id: string): void { this.batchTaskIds = this.batchTaskIds.filter(value => value !== id); }
  public async startBatch(): Promise<void> {
    if (this.starting) return;
    this.startError = ''; this.startNotice = '';
    if (this.launchConfigurationProblems.length) { this.startError = this.launchConfigurationProblems.join(' '); return; }
    if (!this.batchTaskIds.length || this.batchTaskIds.length > BATCH_TASK_LIMIT || this.batchBlocked) { this.startError = 'Выберите доступные задачи и уберите заблокированные из группы.'; return; }
    const taskIds = [...this.batchTaskIds]; const settings = structuredClone(this.settings);
    const signature = JSON.stringify({ taskIds, settings });
    if (this.batchRequest?.signature !== signature) this.batchRequest = { signature, id: crypto.randomUUID() };
    this.starting = true;
    try {
      const response = await firstValueFrom(this.http.post<{ runs: AgentRun[] }>('/api/automation/batch', { taskIds, settings, requestId: this.batchRequest!.id }));
      if (this.destroyed) return;
      this.batchTaskIds = []; this.batchRequest = undefined; this.startNotice = `В очередь добавлено задач: ${response.runs.length}.`;
      await this.poll();
      this.openQueue(null);
    } catch (error) { if (!this.destroyed) this.startError = 'Ошибка запуска группы: ' + this.errorMessage(error); }
    finally { this.starting = false; this.changeDetector.markForCheck(); }
  }
  private get availableTasks(): readonly TaskSummary[] { return this.store.tasks(); }
  private latestTasks: readonly TaskLaunchCandidate[] | null = null;
  public readonly taskSelectionLimit = TASK_SELECTION_LIMIT;
  public get taskListLimited(): boolean { return (this.latestTasks?.length ?? 0) >= TASK_SELECTION_LIMIT; }
  private taskOptionsCache: { label: string; value: string; disabled: boolean; readiness: TaskReadiness; title: string }[] = [];
  private taskOptionsSignature = '';
  public readonly taskControl = new FormControl<string | null>(null);
  public get selectedTask(): string | null { return this.taskControl.value; }
  public settingsScope: 'project' | 'task' = 'project';
  public taskOverridden = false;
  public readonly scopeOptions = [{ label: 'Настройки проекта', value: 'project' }, { label: 'Команда выбранной задачи', value: 'task' }];
  public addRole: AgentRole = AgentRole.Developer;
  private projectDraft?: AutomationSettings;
  private loadedTask: string | null = null;
  public get taskTeamReady(): boolean { return this.settingsScope === 'project' || !!this.selectedTask && this.loadedTask === this.selectedTask; }
  private loadedTeamSignature = '';
  private readonly taskDrafts = new Map<string, { settings: AutomationSettings; overridden: boolean }>();
  public get settingsTaskOptions() { return (this.latestTasks ?? this.availableTasks).map(task => ({ label: `${task.id} · ${task.title}`, value: task.id })); }
  private cacheDraft(): void {
    if (this.settingsScope === 'project') this.projectDraft = structuredClone(this.settings);
    else if (this.loadedTask) {
      if (this.teamSignature(this.settings) === this.loadedTeamSignature) this.taskDrafts.delete(this.loadedTask);
      else this.taskDrafts.set(this.loadedTask, { settings: structuredClone(this.settings), overridden: this.taskOverridden });
    }
  }
  private teamSignature(settings: AutomationSettings): string { return JSON.stringify([settings.agents, settings.routingProfileIds, settings.browser, settings.pipeline, settings.pipelineRoutes, settings.maxStageToolCalls, settings.maxAgentCalls, settings.maxInputTokens, settings.maxRunMinutes, settings.timeoutMinutes, settings.maxRevisions]); }
  private async loadTaskTeam(id: string): Promise<void> {
    const value = await firstValueFrom(this.http.get<{ settings: AutomationSettings; overridden: boolean }>(`/api/automation/tasks/${encodeURIComponent(id)}/team`));
    if (this.settingsScope !== 'task' || id !== this.selectedTask) return;
    this.loadedTeamSignature = this.teamSignature(value.settings);
    const draft = this.taskDrafts.get(id)?.settings;
    this.settings = structuredClone(draft ? { ...value.settings, agents: draft.agents, routingProfileIds: draft.routingProfileIds, browser: draft.browser, pipeline: draft.pipeline, pipelineRoutes: draft.pipelineRoutes, maxStageToolCalls: draft.maxStageToolCalls, maxAgentCalls: draft.maxAgentCalls, maxInputTokens: draft.maxInputTokens, maxRunMinutes: draft.maxRunMinutes, timeoutMinutes: draft.timeoutMinutes, maxRevisions: draft.maxRevisions } : value.settings);
    this.taskOverridden = value.overridden; this.loadedTask = id;
  }
  public changeScope(scope: 'project' | 'task'): void {
    const section = this.tabs.find(item => item.value === this.activeTab);
    this.navigateSettings(scope === 'task' && !section?.task ? AutomationTab.Team : this.activeTab, scope);
  }
  private applyRoute(initial = false): void {
    const { paramMap, queryParamMap } = this.route.snapshot;
    const scope = queryParamMap.get('scope') === 'task' ? 'task' : 'project';
    const section = this.tabs.find(item => item.value === paramMap.get('section'));
    const linkedWorkspace = queryParamMap.get('workspace');
    const id = !linkedWorkspace || linkedWorkspace === this.workspace.current() ? queryParamMap.get('taskId') : null;
    const scopeChanged = scope !== this.settingsScope;
    const taskChanged = id !== this.routedTaskId;
    const batch = scope === 'project' && queryParamMap.get('batch') === '1';
    const launchModeChanged = section?.value === AutomationTab.Launch && batch !== this.batchMode;
    const tabChanged = section?.value !== this.activeTab;
    if (!initial && (scopeChanged || taskChanged)) this.cacheDraft();
    this.settingsScope = scope;
    this.routedTaskId = id;
    this.activeTab = section && (scope === 'project' || section.task) ? section.value : AutomationTab.Team;
    this.batchMode = batch;
    if (launchModeChanged) this.startError = '';
    if (id !== this.selectedTask) this.taskControl.setValue(id, { emitEvent: false });
    if (tabChanged || launchModeChanged) this.scrollPane?.nativeElement.scrollTo(0, 0);
    this.changeDetector.markForCheck();
    if (initial || (!scopeChanged && !(scope === 'task' && taskChanged))) return;
    this.confirmPublish = false;
    void this.act(async () => {
      if (scope === 'task' && id) await this.loadTaskTeam(id);
      else if (scope === 'project') this.settings = structuredClone(this.projectDraft ?? await firstValueFrom(this.http.get<AutomationSettings>('/api/automation/settings')));
    });
  }
  public inheritTeam(): void {
    if (!this.selectedTask) return;
    const id = this.selectedTask;
    void this.act(async () => { const value = await firstValueFrom(this.http.post<{ settings: AutomationSettings; overridden: boolean }>(`/api/automation/tasks/${id}/team/reset`, {})); this.taskDrafts.delete(id); this.settings = value.settings; this.loadedTask = id; this.loadedTeamSignature = this.teamSignature(this.settings); this.taskOverridden = false; this.notice = 'Задача наследует команду проекта.'; });
  }
  public toggleStage(id: string, selected: boolean): void {
    const index = this.settings.pipeline.indexOf(id);
    if (selected) {
      if (index < 0) Object.assign(this.settings, PipelinePolicy.includeStage(this.settings, id));
      return;
    }
    if (index < 0) return;
    const successor = this.settings.pipeline[PipelinePolicy.passStage(this.settings, index)] ?? null;
    const pipeline = this.settings.pipeline.filter(stage => stage !== id);
    const pipelineRoutes = this.settings.pipelineRoutes?.map(route => route.passTo === id ? { ...route, passTo: successor } : route);
    this.settings.pipelineRoutes = PipelinePolicy.routesFor({ ...this.settings, pipelineRoutes }, pipeline);
    this.settings.pipeline = pipeline;
  }
  public get launchConfigurationProblems(): string[] { return PipelinePolicy.configurationProblems(this.settings); }
  public get launchOutcomeHint(): string {
    if (!this.settings.pipeline.length) return 'Выберите этапы запуска.';
    if (PipelinePolicy.writes(this.settings)) return 'Результат запуска: изменения кода по задаче и проверка результата.';
    if (PipelinePolicy.roles(this.settings).includes('analyst')) return 'Результат запуска: анализ и план. Разработчик не выбран — код изменяться не будет.';
    return 'Результат запуска: проверка и замечания. Разработчик не выбран — код изменяться не будет.';
  }
  public returnToTaskLaunch = false;
  public configureLaunchProject(): void {
    this.returnToTaskLaunch = this.settingsScope === 'task';
    this.navigateSettings(AutomationTab.Project, 'project');
  }
  public backToTaskLaunch(): void {
    this.navigateSettings(AutomationTab.Launch, 'task'); this.returnToTaskLaunch = false;
  }
  public get launchAgents(): AgentProfile[] {
    const position = (id: string) => { const index = this.settings.pipeline.indexOf(id); return index < 0 ? Infinity : index; };
    return [...this.settings.agents].sort((a, b) => position(a.id) - position(b.id));
  }
  public get taskOptions() {
    const options = (this.latestTasks ?? this.availableTasks).map((task) => {
      const readiness = TaskAutomationReadiness.evaluate(task, this.settings, this.activeTaskIds.includes(task.id));
      return { value: task.id, title: task.title, label: `${task.id} · ${task.title} · ${TASK_STATUS_TITLES[task.status]} · ${readiness.summary}${task.trustedExecution ? ' · Без лимитов' : ''}`,
        disabled: !readiness.canStart, readiness };
    });
    const signature = JSON.stringify(options);
    if (signature !== this.taskOptionsSignature) { this.taskOptionsSignature = signature; this.taskOptionsCache = options; }
    return this.taskOptionsCache;
  }
  public get selectedEligibility(): TaskReadiness | undefined { return this.taskOptions.find((option) => option.value === this.selectedTask)?.readiness; }
  private readonly http = inject(HttpClient);
  private readonly trackerApi = inject(TrackerApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly workspace = inject(WorkspaceService);
  @ViewChild('commandText') private commandText?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('folderCommandText') private folderCommandText?: ElementRef<HTMLTextAreaElement>;
  public folderConnectOpen = false;
  public showFolderCommand = false;
  public cancelFolderConnection(): void {
    this.pendingFolderPick = false;
    this.folderConnectOpen = false;
    this.showFolderCommand = false;
  }
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
  private modelKey(agent: Pick<AgentProfile, 'connectionId' | 'runner'>): string {
    const connection = this.settings.connections.find((entry) => entry.id === agent.connectionId);
    return connection ? ModelCatalogKey.create({ runner: agent.runner, connection }) : '';
  }
  public modelOptions(agent: Pick<AgentProfile, 'id' | 'runner' | 'connectionId' | 'model'>): ModelOption[] {
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
  public modelMessage(agent: Pick<AgentProfile, 'runner' | 'connectionId'>): string {
    if (!this.host.online) return 'Worker не подключён. Запустите воркер: npm run worker';
    if (!agent.connectionId) return 'Сначала выберите подключение в списке выше.';
    return this.modelMessages.get(this.modelKey(agent)) ?? 'Нажмите «Обновить модели»: список придёт с компьютера worker.';
  }
  public modelButtonTitle(agent: Pick<AgentProfile, 'connectionId'>): string {
    if (!this.host.online) return 'Worker не подключён. Запустите: npm run worker';
    if (!agent.connectionId) return 'Сначала выберите подключение агента';
    if (this.projectBusy) return 'Выполняется другой запрос к worker...';
    return 'Запросить список моделей с компьютера worker';
  }
  public ollamaConnectionId = '';
  public ollamaModel = '';
  public get ollamaConnections() { return this.settings.connections.filter(connection => connection.kind === ProviderKind.Ollama); }
  public unloadOllama(): void {
    const connection = this.ollamaConnections.find(entry => entry.id === this.ollamaConnectionId);
    const model = this.ollamaModel.trim();
    if (!connection || !model || !window.confirm(`Выгрузить ${model} на «${connection.label}»? Это может затронуть другие запросы к этой модели.`)) return;
    void this.project({ action: ProjectAction.UnloadOllama, path: '', model,
      catalog: { runner: RunnerId.ModelApi, connection: structuredClone(connection) } }, result => {
      if (result.unloaded !== model) throw new Error('Worker не подтвердил выгрузку модели.');
      this.notice = `Ollama подтвердила выгрузку ${model}.`;
    });
  }
  public async loadModels(agent: Pick<AgentProfile, 'runner' | 'connectionId'>): Promise<void> {
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
  public toggleManualModel(agent: Pick<AgentProfile, 'id'>): void {
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
  public runnerOptions(agent: Pick<AgentProfile, 'connectionId'>) {
    const native = this.settings.connections.find(c => c.id === agent.connectionId)?.kind === ProviderKind.Native;
    return native ? this.nativeRunnerOptions : this.apiRunnerOptions;
  }
  public readonly providers = [...PROVIDER_KINDS];
  public readonly reasoningEfforts = [...REASONING_EFFORTS];
  public readonly mergePolicies = [...MERGE_POLICIES];
  public readonly dependencyModes = ['isolated', 'linked'];
  public readonly providerKind = ProviderKind;
  public readonly runnerId = RunnerId;
  public readonly limits = AUTOMATION_LIMITS;
  public readonly budgetPresets = [
    {
      id: 'quick',
      label: 'Быстрый',
      description: 'До 30 инстр., 15 мин/этап, 30 мин всего (для небольших правок)',
      maxStageToolCalls: 30,
      timeoutMinutes: 15,
      maxRunMinutes: 30,
      maxAgentCalls: 10,
      maxRevisions: 1,
      maxInputTokens: 2000000,
    },
    {
      id: 'standard',
      label: 'Стандартный',
      description: 'До 60 инстр., 30 мин/этап, 60 мин всего (рекомендуемый)',
      maxStageToolCalls: 60,
      timeoutMinutes: 30,
      maxRunMinutes: 60,
      maxAgentCalls: 20,
      maxRevisions: 2,
      maxInputTokens: 5000000,
    },
    {
      id: 'deep',
      label: 'Углублённый',
      description: 'До 100 инстр., 45 мин/этап, 120 мин всего (для больших фич и рефакторинга)',
      maxStageToolCalls: 100,
      timeoutMinutes: 45,
      maxRunMinutes: 120,
      maxAgentCalls: 35,
      maxRevisions: 3,
      maxInputTokens: 10000000,
    },
    {
      id: 'maximum',
      label: 'Максимальный',
      description: 'До 180 инстр., 60 мин/этап, 240 мин всего (для масштабных автономных задач)',
      maxStageToolCalls: 180,
      timeoutMinutes: 60,
      maxRunMinutes: 240,
      maxAgentCalls: 50,
      maxRevisions: 5,
      maxInputTokens: 20000000,
    },
  ] as const;
  public selectedBudgetPresetId: string = 'standard';
  public applyBudgetPreset(presetId: string): void {
    const preset = this.budgetPresets.find(p => p.id === presetId);
    if (!preset) return;
    this.selectedBudgetPresetId = preset.id;
    this.settings.maxStageToolCalls = preset.maxStageToolCalls;
    this.settings.timeoutMinutes = preset.timeoutMinutes;
    this.settings.maxRunMinutes = preset.maxRunMinutes;
    this.settings.maxAgentCalls = preset.maxAgentCalls;
    this.settings.maxRevisions = preset.maxRevisions;
    this.settings.maxInputTokens = preset.maxInputTokens;
  }
  public readonly providerOptions = PROVIDER_OPTIONS;
  public readonly roleOptions = ROLE_OPTIONS.filter((option) => option.value !== AgentRole.Doctor);
  private readonly systemRoles = [
    { value: 'doctorAgent', label: 'Pipeline Doctor' },
    { value: 'auditAgent', label: 'Аудитор этапов' },
  ] as const;
  public selectedSystemRole: 'doctorAgent' | 'auditAgent' | null = null;
  public readonly connectionPresets = CONNECTION_PRESETS;
  public readonly nativeRunnerOptions = RUNNER_OPTIONS.filter(option => option.value !== RunnerId.ModelApi);
  public readonly apiRunnerOptions = RUNNER_OPTIONS.filter(option => option.value === RunnerId.ModelApi);
  public nativeRunner(connection: ModelConnection): RunnerId {
    return nativeConnectionRunner(connection);
  }
  public setNativeRunner(connection: ModelConnection, runner: RunnerId): void {
    connection.nativeRunner = runner; this.providerChanged(connection);
  }
  public providerChanged(connection: ModelConnection): void {
    if (connection.kind !== ProviderKind.Native) delete connection.nativeRunner;
    for (const agent of this.settings.agents.filter(agent => agent.connectionId === connection.id)) this.selectConnection(agent);
    const audit = this.settings.auditAgent;
    if (audit?.connectionId === connection.id) {
      audit.runner = stageAuditRunner(connection);
      audit.model = '';
      audit.enabled = false;
    }
  }
  private scriptProject: PackageManagerInfo = { packageManager: 'npm', hasLockfile: false };
  public get packageManager(): PackageManagerInfo['packageManager'] { return this.currentScriptProject.packageManager; }
  private get currentScriptProject(): PackageManagerInfo {
    return this.npmScriptPath && this.npmScriptPath === this.settings.repositoryPath ? this.scriptProject : { packageManager: 'npm', hasLockfile: false };
  }
  public get setupPresets(): readonly CommandPreset[] {
    if (this.packageManager === 'npm') return SETUP_PRESETS;
    const value = pnpmInstall(this.currentScriptProject.hasLockfile);
    return [{ id: 'pnpm-install', label: this.commandLabel(value), description: 'Установить зависимости в рабочей копии через pnpm', value }];
  }
  public get checkPresets(): readonly CommandPreset[] {
    return this.packageManager === 'npm' ? CHECK_PRESETS : CHECK_PRESETS.map(preset => {
      const value = packageScript('pnpm', preset.id);
      return { ...preset, value, description: this.commandLabel(value) };
    });
  }
  public npmScripts: (CommandPreset & { body?: string })[] = [];
  public npmScriptPath = '';
  public npmScriptId = '';
  public readonly npmScriptPhases = [
    { label: 'Подготовка', value: 'setup', description: 'Подготовить рабочую копию перед разработкой' },
    { label: 'Проверки', value: 'checks', description: 'Проверить изменения, например собрать проект или запустить тесты' },
    { label: 'Пост-операции', value: 'postOp', description: 'Выполнить действие после конвейера, например развернуть сборку' },
  ];
  public npmScriptPhase: 'setup' | 'checks' | 'postOp' = 'postOp';
  public postOpScriptId = '';
  public checkScriptId = '';

  public get availableCheckPresets(): readonly CommandPreset[] {
    if (!this.npmScripts.length) return this.checkPresets;
    return this.checkPresets.filter(p => this.isPresetAvailable(p));
  }

  public get availablePostOpPresets(): readonly CommandPreset[] {
    if (!this.npmScripts.length) return this.checkPresets;
    return this.checkPresets.filter(p => this.isPresetAvailable(p));
  }

  public isPresetAvailable(preset: CommandPreset): boolean {
    if (this.npmScriptPath !== this.settings.repositoryPath || !this.npmScripts.length) return true;
    if (preset.value.command === 'npm' || preset.value.command === 'pnpm') {
      const scriptName = preset.value.args[0] === 'test' ? 'test' : (preset.value.args[0] === 'run' ? preset.value.args[1] : undefined);
      if (scriptName) return this.npmScripts.some(s => s.id === scriptName);
    }
    return true;
  }

  public addScriptToPhase(scriptId: string, phase: 'setup' | 'checks' | 'postOp'): void {
    const script = this.npmScripts.find(s => s.id === scriptId);
    if (script && !this.commandSelected(script.value, phase)) {
      this.toggleCommand(script.value, phase);
    }
  }

  public isScriptSelectedInPhase(scriptId: string, phase: 'setup' | 'checks' | 'postOp'): boolean {
    const script = this.npmScripts.find(s => s.id === scriptId);
    if (!script) return false;
    return this.commandSelected(script.value, phase);
  }
  public get selectedNpmScript() {
    return this.npmScriptPath === this.settings.repositoryPath ? this.npmScripts.find(script => script.id === this.npmScriptId) : undefined;
  }
  public addNpmScript(): void {
    const script = this.selectedNpmScript;
    if (script && !this.commandSelected(script.value, this.npmScriptPhase)) this.toggleCommand(script.value, this.npmScriptPhase);
  }
  public host: HostStatus = { online: false };
  public get executorReady(): boolean { return this.host.online && (!this.host.execution || this.host.execution.state === 'running'); }
  public get executorTitle(): string {
    return !this.host.online ? 'локальный хост не подключён' : !this.host.execution ? 'старый worker — обновите подключение для управления' : ({ starting: 'запускается', running: 'работает', stopping: 'останавливается', stopped: 'остановлен' })[this.host.execution.state];
  }
  public controlWorker(start: boolean): void {
    void this.project({ action: start ? ProjectAction.StartWorker : ProjectAction.StopWorker, path: '' }, result => {
      if (result.execution) this.host = { ...this.host, execution: result.execution };
      this.notice = start ? 'Worker запущен на подключённом компьютере.' : 'Worker остановлен. Локальный хост остаётся доступен.';
    });
  }
  public projectBusy = false;
  private passport: ProjectPassport | null = null;
  public get projectPassport(): ProjectPassport | null {
    return this.passport?.path === this.settings.repositoryPath && this.passport.branch === this.settings.baseBranch ? this.passport : null;
  }
  public browserOpen = false;
  public parentFolder = '';
  public folderNodes: TreeNode<string>[] = [];
  public selectedFolder: TreeNode<string> | null = null;
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
      const field = this.folderConnectOpen ? this.folderCommandText : this.commandText;
      field?.nativeElement.focus(); field?.nativeElement.select();
    }
    this.changeDetector.markForCheck();
  }
  public setProjectPath(value: string): void { this.settings.repositoryPath = value; this.branchOptions = []; this.launchNotice = ''; }
  private destroyed = false;
  private connectionOptionsSignature = '';
  private connectionOptionsCache: { label: string; value: string }[] = [];
  public ngOnInit(): void {
    this.applyRoute(true);
    this.router.events.pipe(filter(event => event instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyRoute());
    this.http.get<SkillSummary[]>('/api/automation/skills').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: catalog => { this.library = catalog; this.changeDetector.markForCheck(); },
      error: () => { this.error = 'Не удалось загрузить библиотеку навыков.'; },
    });
    this.destroyRef.onDestroy(() => { this.destroyed = true; });
    this.taskControl.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.startError = ''; this.cacheDraft();
      this.navigateSettings(this.activeTab, this.settingsScope);
      this.changeDetector.markForCheck();
    });
    void this.act(async () => {
      const project = await this.readProjectTeam();
      this.baseTeam = project.base;
      const prepared = this.teamProfiles.prepare(project.settings, project.base.mode === 'independent');
      this.settings = prepared.settings;
      this.projectDraft = structuredClone(this.settings);
      if (this.settingsScope === 'task' && this.selectedTask) await this.loadTaskTeam(this.selectedTask);
      if (prepared.repaired) this.repairNotice = 'Исправлены совпадающие ID агентов в черновике. Проверьте порядок этапов и сохраните настройки.';
      await this.refresh();
      const { passport } = await firstValueFrom(this.http.get<{ passport: ProjectPassport | null }>('/api/automation/project-passport'));
      this.passport ??= passport;
      if (this.passport && !this.npmScripts.length) {
        this.initNpmScriptsFromPassport(this.passport);
      }
    });
    timer(AUTOMATION_TIMING.pollMs, AUTOMATION_TIMING.pollMs).pipe(
      filter(() => !this.busy && !this.starting), exhaustMap(() => this.poll()), takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }
  private initNpmScriptsFromPassport(passport: ProjectPassport): void {
    const npmCmds = passport.commands.find(c => c.source === 'package.json');
    this.applyNpmScripts({ path: passport.path, scripts: npmCmds?.names, packageManager: passport.packageManager, hasLockfile: passport.hasLockfile });
  }

  public addPresetConnection(id: ConnectionPreset): string {
    const preset = CONNECTION_PRESETS.find((entry) => entry.id === id)!;
    const connectionId = crypto.randomUUID();
    this.insertConnection({ ...structuredClone(preset.connection), id: connectionId });
    this.notice = `Подключение «${preset.label}» добавлено. Выберите его у нужных агентов.`;
    return connectionId;
  }
  public readonly fieldTooltips: Record<string, string> = {
    repositoryPath: 'Путь к папке git-репозитория на компьютере worker для сборки и проверок.',
    baseBranch: 'Базовая ветка репозитория, от которой создаются задачи и куда сливаются изменения.',
    newBranch: 'Имя новой ветки для создания от базовой без смены рабочей папки.',
    setupCommands: 'Команды подготовки окружения перед запуском агентов. Worker определяет пакетный менеджер проекта.',
    checkCommands: 'Обязательные автопроверки (тесты, линтер, сборка) после работы разработчика.',
    postOperations: 'Команды, выполняемые автоматически после завершения основного конвейера агентов.',
    artifactPaths: 'Относительные пути к артефактам и отчетам для сохранения в результатах.',
    connectionLabel: 'Понятное название подключения для выбора у агентов.',
    connectionKind: 'Тип провайдера: нативный CLI (Codex, Claude Code) или API эндпоинт.',
    baseUrl: 'URL эндпоинта API для обращений к модели.',
    credentialEnv: 'Имя переменной окружения на worker, где хранится API-ключ.',
    reasoningEffort: 'Уровень глубины рассуждения для поддерживающих моделей.',
    nativeRunner: 'Утилита командной строки на worker, выполняющая роль агента.',
    agentRole: 'Роль агента в пайплайне: планирование, разработка, тесты или ревью.',
    agentConnection: 'Подключение модели или CLI, используемое этим агентом.',
    agentModel: 'Имя или идентификатор используемой модели нейросети.',
    agentInstructions: 'Специальные системные инструкции для этого агента.',
    timeoutMinutes: 'Максимальное время работы одного шага агента в минутах.',
    maxRevisions: 'Максимум циклов исправлений замечаний тестировщика или ревьюера.',
    maxAgentCalls: 'Общий лимит вызовов агентов на весь запуск задачи.',
    maxStageToolCalls: 'Максимум вызовов инструментов агента за один шаг.',
    maxInputTokens: 'Лимит входных токенов контекста для контроля расхода бюджета.',
    maxRunMinutes: 'Предельное общее время выполнения задачи в минутах.',
    maxParallelRuns: 'Максимальное число одновременно выполняемых задач.',
    dependencyMode: 'Режим зависимостей: isolated (отдельные) или linked (общие node_modules).',
    mergePolicy: 'Политика слияния: manual (вручную) или local (автоматический squash-merge).',
    maxMergeAttempts: 'Число попыток разрешения конфликтов при автоматическом слиянии.',
    resolveConflicts: 'Автоматически разрешать конфликты слияния с помощью агента.',
  };
  private getCommandList(phase: 'setup' | 'checks' | 'postOp' | boolean): CheckCommand[] {
    if (phase === true || phase === 'setup') return this.settings.setup;
    if (phase === 'postOp') {
      if (!this.settings.postOperations) this.settings.postOperations = [];
      return this.settings.postOperations;
    }
    return this.settings.checks;
  }
  public commandSelected(value: CheckCommand, phase: 'setup' | 'checks' | 'postOp' | boolean): boolean {
    const list = this.getCommandList(phase);
    return list.some(entry => this.sameCommand(entry, value));
  }
  public toggleCommand(value: CheckCommand, phase: 'setup' | 'checks' | 'postOp' | boolean): void {
    const list = this.getCommandList(phase);
    const index = list.findIndex(entry => this.sameCommand(entry, value));
    if (index >= 0) list.splice(index, 1); else list.push(structuredClone(value));
  }
  private effectiveCommand(value: CheckCommand): CheckCommand {
    try { return projectCommand(value, this.currentScriptProject); }
    catch { return value; }
  }
  private sameCommand(first: CheckCommand, second: CheckCommand): boolean {
    const a = this.effectiveCommand(first);
    const b = this.effectiveCommand(second);
    return a.command === b.command && this.json(a.args) === this.json(b.args);
  }
  public commandLabel(value: CheckCommand): string {
    const command = this.effectiveCommand(value);
    return [command.command, ...command.args].join(' ');
  }
  public pickFolder(): void {
    if (!this.host.online) {
      this.pendingFolderPick = true;
      this.folderConnectOpen = true;
      return;
    }
    this.browse(this.settings.repositoryPath.trim());
  }
  public readProjectIfNeeded(event?: FocusEvent): void {
    if (event?.relatedTarget instanceof Element && event.relatedTarget.closest('[data-project-picker]')) return;
    if (this.host.online && !this.projectBusy && this.settings.repositoryPath.trim() && this.inspectedPath !== this.settings.repositoryPath) this.inspect();
  }
  public browse(path = ''): void {
    if (this.projectBusy) return;
    this.notice = 'Читаем каталоги на компьютере воркера…';
    void this.project({ action: ProjectAction.Browse, path }, result => {
      this.parentFolder = result.parent !== result.path ? result.parent ?? '' : '';
      const root = this.folderNode(result.path, result.path);
      root.children = (result.directories ?? []).map(entry => this.folderNode(entry.name, entry.path));
      root.expanded = true;
      root.leaf = !root.children.length;
      this.selectedFolder = root;
      this.folderNodes = [root, ...(result.drives ?? []).filter(drive => drive.slice(0, 2).toLowerCase() !== result.path.toLowerCase().replace(/[\\/]$/, ''))
        .map(drive => this.folderNode(drive, drive))];
      this.browserOpen = true;
    }).finally(() => {
      if (this.notice === 'Читаем каталоги на компьютере воркера…') this.notice = '';
      if (!this.destroyed) this.changeDetector.markForCheck();
    });
  }
  public inspect(): void { void this.project({ action: ProjectAction.Inspect, path: this.settings.repositoryPath }, (result) => this.applyProject(result)); }
  public async createDocumentationTask(): Promise<void> {
    await this.act(async () => {
      const response = await firstValueFrom(this.trackerApi.createTask({
        title: 'Исследовать проект и предложить документацию', type: 'task',
        description: [
          'Проверь существующие AGENTS.md, README, архитектурные документы, SKILL.md, конфиги запуска и CI.',
          'Найди пробелы в описании архитектуры, запуска и отладки, принципов разработки и полезных референсов.',
          'Подготовь в плане SAT полные черновики предлагаемых файлов или правок, укажи пути и источники в репозитории.',
          'На первом этапе работай в режиме чтения. Верни вопрос о согласовании черновика. Дождись подтверждения пользователя и используй отредактированный им план перед записью файлов и коммитом.',
        ].join('\n\n'),
      }));
      this.notice = `Создана задача ${response.task.id}. Откройте её и запустите этап аналитика для подготовки черновика.`;
      await this.refresh();
    });
  }
  public researchStatus = '';
  public researchError = '';
  public researchProject(): void {
    const path = this.settings.repositoryPath;
    void this.project({ action: ProjectAction.Research, path, baseBranch: this.settings.baseBranch }, result => {
      if (!result.passport) throw new Error('Worker не вернул паспорт. Проверьте его версию.');
      if (this.settings.repositoryPath === path) this.settings.repositoryPath = result.path;
      this.passport = result.passport;
      if (this.settings.repositoryPath === result.path) this.initNpmScriptsFromPassport(result.passport);
      this.researchStatus = 'Исследование завершено. Черновик паспорта сохранён.';
    });
  }
  private folderNode(label: string, folder: string): TreeNode<string> {
    return { label, data: folder, leaf: false, icon: 'pi pi-folder' };
  }
  public async expandFolder(node: TreeNode<string>): Promise<void> {
    if (node.children || !node.data) return;
    const result = await this.project({ action: ProjectAction.Browse, path: node.data }, result => {
      node.children = (result.directories ?? []).map(entry => this.folderNode(entry.name, entry.path));
      node.leaf = !node.children.length;
    });
    if (!result) node.expanded = false;
    this.folderNodes = [...this.folderNodes];
    if (!this.destroyed) this.changeDetector.markForCheck();
  }
  public chooseDirectory(): void {
    if (!this.selectedFolder?.data) return;
    this.setProjectPath(this.selectedFolder.data);
    this.browserOpen = false;
    this.inspect();
  }
  public createBranch(): void {
    void this.project({ action: ProjectAction.CreateBranch, path: this.settings.repositoryPath, baseBranch: this.settings.baseBranch, newBranch: this.newBranch }, (result) => {
      this.applyProject(result); this.settings.baseBranch = this.newBranch; this.newBranch = ''; this.notice = 'Ветка создана без переключения рабочей папки. Сохраните настройки.';
    });
  }
  private applyProject(result: ProjectResult): void {
    this.inspectedPath = result.path;
    this.settings.repositoryPath = result.path; this.branchOptions = result.branches ?? [];
    if (!this.branchOptions.includes(this.settings.baseBranch)) this.settings.baseBranch = result.currentBranch || this.branchOptions[0] || '';
    this.applyNpmScripts(result);
    this.notice = 'Проект прочитан на worker. Выберите ветку и команды из package.json.';
  }
  public refreshNpmScripts(): void {
    const path = this.settings.repositoryPath;
    void this.project({ action: ProjectAction.Inspect, path }, result => {
      if (this.settings.repositoryPath !== path) return;
      this.applyNpmScripts(result, path);
    });
  }
  private applyNpmScripts(result: ProjectResult, path = result.path): void {
    this.npmScriptPath = path;
    this.scriptProject = { packageManager: result.packageManager ?? 'npm', hasLockfile: result.hasLockfile ?? false };
    this.npmScripts = (result.scripts ?? []).map((script) => {
      const value = packageScript(this.scriptProject.packageManager, script);
      return { id: script, label: script, description: this.commandLabel(value), value,
        body: result.scriptBodies && Object.hasOwn(result.scriptBodies, script) ? result.scriptBodies[script] : undefined };
    });
    if (!this.npmScripts.some(script => script.id === this.npmScriptId)) this.npmScriptId = '';
  }
  private async project(input: ProjectInput, apply: (result: ProjectResult) => void): Promise<ProjectResult | undefined> {
    if (this.projectBusy) return;
    const research = input.action === ProjectAction.Research;
    if (research) {
      this.researchStatus = 'Отправляем запрос на исследование…';
      this.researchError = '';
    }
    this.projectBusy = true; this.error = ''; this.changeDetector.markForCheck();
    try {
      const request = await lastValueFrom(this.http.post<ProjectRequest>('/api/automation/project-requests', input).pipe(
        tap(() => {
          if (research) {
            this.researchStatus = 'Запрос в очереди. Ожидаем воркер…';
            this.changeDetector.markForCheck();
          }
        }),
        switchMap((created) => timer(PROJECT_LIMITS.pollMs, PROJECT_LIMITS.pollMs).pipe(
          exhaustMap(() => this.http.get<ProjectRequest>(`/api/automation/project-requests/${created.id}`)),
        )),
        tap(value => {
          if (research && value.status === ProjectRequestStatus.Running) {
            this.researchStatus = `Воркер исследует ветку «${input.baseBranch}» и собирает паспорт…`;
            this.changeDetector.markForCheck();
          }
        }),
        takeWhile((value) => value.status === ProjectRequestStatus.Queued || value.status === ProjectRequestStatus.Running, true),
        last(), timeout({ first: PROJECT_LIMITS.requestMs + 10000 }), takeUntilDestroyed(this.destroyRef),
      ));
      if (this.destroyed) return;
      if (request.error || !request.result) throw new Error(request.error || 'Worker не вернул результат.');
      apply(request.result);
      return request.result;
    } catch (error) {
      if (!this.destroyed) {
        this.error = this.errorMessage(error);
        if (research) {
          this.researchError = error instanceof TimeoutError
            ? `${this.researchStatus} Интерфейс не получил итоговый статус от SAT. Повторите запрос, если паспорт не появился.`
            : this.error;
          this.error = this.researchError;
          this.researchStatus = '';
        }
      }
    }
    finally { this.projectBusy = false; if (!this.destroyed) this.changeDetector.markForCheck(); }
  }
  public get connectionOptions() {
    const signature = JSON.stringify([this.settingsScope, this.settings.connections.map(({ id, label }) => ({ id, label }))]);
    if (signature !== this.connectionOptionsSignature) {
      this.connectionOptionsSignature = signature;
      this.connectionOptionsCache = [
        ...this.settings.connections.map((entry) => ({ label: entry.label || entry.id, value: entry.id })),
        ...(this.settingsScope === 'project' ? CONNECTION_PRESETS.map(preset => ({ label: `＋ ${preset.label} — добавить подключение`, value: `preset:${preset.id}` })) : []),
      ];
    }
    return this.connectionOptionsCache;
  }
  public get availableSystemRoles() {
    return this.systemRoles.filter(role => !this.settings[role.value] &&
      (role.value !== 'doctorAgent' || !(this.settings.doctorConnectionId || this.settings.doctorModel)));
  }
  public get doctorAgent(): AgentProfile | undefined {
    if (!this.settings.doctorAgent && (this.settings.doctorConnectionId || this.settings.doctorModel)) {
      this.addSystemRole('doctorAgent');
    }
    return this.settings.doctorAgent;
  }
  public addSystemRole(role = this.selectedSystemRole): void {
    if (!role || this.settings[role]) return;
    if (role === 'doctorAgent') {
      const fallbackConn = this.settings.connections.find(c => c.isLocal || c.kind === ProviderKind.Ollama)?.id || this.settings.connections[0]?.id || '';
      this.settings.doctorAgent = {
        id: 'pipeline-doctor',
        role: AgentRole.Doctor,
        runner: RunnerId.ModelApi,
        connectionId: this.settings.doctorConnectionId || fallbackConn,
        model: this.settings.doctorModel || '',
        instructions: DEFAULT_ROLE_INSTRUCTIONS[AgentRole.Doctor] ?? '',
      };
    } else {
      this.settings.auditAgent = { id: 'stage-audit', role: 'stage-audit', runner: RunnerId.ModelApi,
        connectionId: '', model: '', instructions: '', enabled: false };
      this.manualModels.add(this.settings.auditAgent.id);
    }
    this.selectedSystemRole = null;
  }
  public removeSystemRole(role: 'doctorAgent' | 'auditAgent'): void {
    delete this.settings[role];
    if (role === 'doctorAgent') {
      delete this.settings.doctorConnectionId;
      delete this.settings.doctorModel;
    }
  }
  public get auditReady(): boolean {
    const audit = this.settings.auditAgent;
    const connection = this.settings.connections.find(entry => entry.id === audit?.connectionId);
    if (!audit?.model.trim() || !connection) return false;
    if (connection.kind !== ProviderKind.Native) return !!connection.baseUrl?.trim();
    if (audit.runner === RunnerId.DeepSeekHarness) return !!audit.nativeProfile?.trim();
    if (audit.runner === RunnerId.Custom) return !!audit.command?.trim() && Array.isArray(audit.args);
    return true;
  }
  public changeSystemConnection(agent: AgentProfile | NonNullable<AutomationSettings['auditAgent']>, connectionId: string): void {
    if (agent.role !== 'stage-audit') {
      agent.connectionId = connectionId;
      this.selectConnection(agent);
      return;
    }
    if (agent.connectionId === connectionId) return;
    if (agent.connectionId) agent.model = '';
    agent.connectionId = connectionId;
    this.selectConnection(agent);
    agent.runner = stageAuditRunner(this.settings.connections.find(entry => entry.id === agent.connectionId));
    agent.enabled = false;
  }
  public resetSystemInstructions(agent: AgentProfile | NonNullable<AutomationSettings['auditAgent']>): void {
    if (agent.role === 'stage-audit') agent.instructions = this.baseTeam?.team?.auditAgent?.instructions ?? '';
    else this.resetInstructions(agent);
  }
  public setSystemArgs(agent: Pick<AgentProfile, 'args'>, value: string): void {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        agent.args = parsed;
      }
    } catch {
      // ignore
    }
  }
  public stageNumber(run: AgentRun): number { return Math.min(run.stage + 1, run.settings.pipeline.length); }
  public addConnection(): void {
    this.insertConnection({ id: `connection-${crypto.randomUUID()}`, label: 'Подключение', kind: ProviderKind.Native, supportsImages: false });
  }
  public get displayedConnections(): readonly ModelConnection[] {
    const connections = this.settings.connections;
    const newest = connections.find(connection => connection.id === this.newestConnectionId);
    return newest ? [newest, ...connections.filter(connection => connection !== newest)] : connections;
  }
  public removeConnection(id: string): void {
    this.settings.connections = this.settings.connections.filter(connection => connection.id !== id);
    const audit = this.settings.auditAgent;
    if (audit?.connectionId === id) this.changeSystemConnection(audit, '');
  }
  private insertConnection(connection: ModelConnection): void {
    this.settings.connections.push(connection);
    if (this.activeTab !== AutomationTab.Models) return;
    this.newestConnectionId = connection.id;
    afterNextRender(() => {
      const field = this.firstConnectionName?.nativeElement;
      field?.scrollIntoView({ block: 'nearest' });
      field?.focus({ preventScroll: true });
      field?.select();
    }, { injector: this.injector });
  }
  public addAgent(role: AgentRole = AgentRole.Developer): void {
    const agent = this.teamProfiles.create(role, this.settings.connections[0]?.id ?? '');
    this.settings.agents.push(agent); this.toggleStage(agent.id, true);
    this.selectConnection(agent);
  }
  public addStandardTeam(): void {
    if (this.settings.agents.length) return;
    for (const role of STANDARD_TEAM_ROLES) this.addAgent(role);
    this.notice = 'Добавлен разработчик. Выберите модель. Воркер выполнит настроенные проверки проекта.';
  }
  public addTeamWithPlanReview(): void {
    if (this.settings.agents.length) return;
    for (const role of FULL_TEAM_ROLES) this.addAgent(role);
    this.notice = 'Добавлена команда с ревью плана и ревью кода. Выберите модели для агентов.';
  }
  public selectConnection(agent: Pick<AgentProfile, 'connectionId' | 'runner'>): void {
    if (agent.connectionId.startsWith('preset:')) {
      const presetId = agent.connectionId.slice('preset:'.length) as ConnectionPreset;
      if (!CONNECTION_PRESETS.some(p => p.id === presetId)) return;
      agent.connectionId = this.addPresetConnection(presetId);
    }
    const connection = this.settings.connections.find((entry) => entry.id === agent.connectionId);
    if (!connection) return;
    if (connection.kind !== ProviderKind.Native) { agent.runner = RunnerId.ModelApi; return; }
    if (connection.nativeRunner) { agent.runner = connection.nativeRunner; return; }
    const preset = CONNECTION_PRESETS.find((entry) => entry.connection.label === connection.label && entry.connection.kind === connection.kind);
    if (preset) agent.runner = preset.runner;
    else if (agent.runner === RunnerId.ModelApi) agent.runner = RunnerId.Codex;
  }
  public removeAgent(id: string): void { this.settings.routingProfileIds = this.settings.routingProfileIds?.filter(profileId => profileId !== id); this.settings.agents = this.settings.agents.filter((entry) => entry.id !== id); this.toggleStage(id, false); }
  public moveStage(index: number, target: number): void {
    if (index < 0 || index >= this.settings.pipeline.length || target < 0 || target >= this.settings.pipeline.length) return;
    Object.assign(this.settings, PipelinePolicy.reorder(this.settings, index, target));
  }
  public roleLabel(role: AgentRole): string { return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role; }
  public profileName(agent: AgentProfile): string { return agentProfileName(agent, this.settings.agents); }
  public changeRole(agent: AgentProfile, role: AgentRole): void { this.teamProfiles.changeRole(agent, role); }
  public resetInstructions(agent: AgentProfile): void {
    const parent = this.settingsScope === 'task' ? this.projectDraft : this.baseTeam?.team;
    const original = parent?.agents.find(profile => profile.id === agent.id && profile.role === agent.role);
    agent.instructions = original?.instructions ?? DEFAULT_ROLE_INSTRUCTIONS[agent.role];
  }
  public agentLabel(id: string): string { const agent = this.settings.agents.find((entry) => entry.id === id); return agent ? `${this.profileName(agent)} · ${agent.runner} · ${agent.model || 'выберите модель'}` : id; }
  public save(): void { void this.act(async () => {
    if (!this.taskTeamReady) throw new Error('Сначала дождитесь загрузки команды выбранной задачи.');
    if (this.settingsScope === 'task') {
      if (!this.selectedTask) throw new Error('Выберите задачу для настройки команды.');
      const value = await firstValueFrom(this.http.post<{ settings: AutomationSettings; overridden: boolean }>(`/api/automation/tasks/${this.selectedTask}/team`, this.settings));
      this.settings = value.settings; this.taskOverridden = value.overridden; this.loadedTeamSignature = this.teamSignature(this.settings); this.cacheDraft(); this.notice = `Команда задачи ${this.selectedTask} сохранена. Настройки проекта не изменены.`;
    } else {
      await firstValueFrom(this.http.post('/api/automation/settings', {...this.settings,
        baseTeamRevision: this.baseTeam?.revision, adoptBaseTeam: this.adoptingTeam}));
      const project = await this.readProjectTeam();
      this.settings = project.settings;
      this.baseTeam = project.base;
      this.projectDraft = structuredClone(this.settings);
      this.adoptingTeam = false;
      this.notice = 'Настройки проекта сохранены.';
    }
    this.repairNotice = '';
  }); }
  public start(): void {
    if (this.starting) return;
    this.startError = ''; this.startNotice = '';
    if (!this.selectedTask) { this.startError = 'Выберите задачу для запуска.'; return; }
    if (!this.settings.pipeline.length) { this.startError = 'Выберите хотя бы один этап запуска.'; return; }
    if (!this.taskTeamReady) { this.startError = 'Команда выбранной задачи ещё не загружена.'; return; }
    if (this.launchConfigurationProblems.length) { this.startError = 'Ошибка запуска: ' + this.launchConfigurationProblems.join(' '); return; }
    if (!this.selectedEligibility?.canStart) { this.startError = this.selectedEligibility?.reasons.join(' ') || 'Задача больше не доступна для запуска. Обновите список.'; return; }
    this.starting = true;
    const taskId = this.selectedTask; const settings = structuredClone(this.settings);
    void (async () => {
      try {
        const { run } = await firstValueFrom(this.http.post<{ run: AgentRun }>('/api/automation/runs', { taskId, settings }));
        if (this.destroyed) return;
        this.submittedRun = run; this.selectedRun = run.id; this.repairNotice = '';
        this.startNotice = this.host.online && !this.executorReady ? `Задача ${taskId} поставлена в очередь. Исполнитель остановлен — нажмите «Запустить worker».` : this.host.online ? `Запуск ${run.id} создан для ${taskId}. Ожидает захвата worker.`
          : `Задача ${taskId} поставлена в очередь. Worker отключён — выполнение ещё не началось. Подключите компьютер в разделе «Компьютер и worker».`;
        await this.poll();
        if (!this.destroyed) this.openQueue(run.id);
      } catch (error) { if (!this.destroyed) this.startError = `Ошибка запуска: ${this.errorMessage(error)}`; }
      finally { this.starting = false; this.changeDetector.markForCheck(); }
    })();
  }
  public addCheck(): void { this.settings.checks.push(packageScript(this.packageManager, 'test')); }
  public addSetup(): void { this.settings.setup.push(this.packageManager === 'pnpm' ? pnpmInstall(this.currentScriptProject.hasLockfile) : structuredClone(DEFAULT_SETUP_COMMAND)); }
  public addPostOp(): void {
    if (!this.settings.postOperations) this.settings.postOperations = [];
    this.settings.postOperations.push(packageScript(this.packageManager, 'build'));
  }
  public setArgs(index: number, value: string, custom = false, phase: 'setup' | 'checks' | 'postOp' | boolean = false): void {
    try {
      const args: unknown = JSON.parse(value);
      if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) throw new Error();
      if (custom) this.settings.agents[index].args = args;
      else this.getCommandList(phase)[index].args = args;
      this.error = '';
    } catch {
      this.error = 'Аргументы: нужен JSON-массив строк.';
    }
  }
  public json(value: unknown): string { return JSON.stringify(value); }
  public setArtifacts(value: string): void { this.settings.artifactPaths = value.split('\n').map((entry) => entry.trim()).filter(Boolean); }
  private async refresh(): Promise<void> {
    this.host = await firstValueFrom(this.http.get<HostStatus>('/api/automation/host'));
    if (!this.destroyed && this.host.online && this.pendingFolderPick && !this.projectBusy) {
      this.cancelFolderConnection();
      this.pickFolder();
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
