import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject, debounceTime, firstValueFrom } from 'rxjs';
import type {
  BackupRecord,
  CreateTaskPayload,
  LinkRelation,
  QuestionPhase,
  SearchScope,
  StatusMeta,
  Tag,
  TaskCard,
  TaskFilters,
  TaskStatus,
  TaskSummary,
  TaskType,
  TrackerMeta,
  UpdateTaskPayload,
} from '../models/tracker.models';
import { DEFAULT_SEARCH_SCOPES, SEARCH_SCOPE_OPTIONS } from '../models/tracker.models';
import { TrackerApiService } from './tracker-api.service';
import { BoardSortService } from './board-sort.service';
import { ColumnSorting } from '../../../../shared/board/column-sort';

/** Метаданные статусов на случай, если /api/meta ещё не загружен. */
const FALLBACK_STATUSES: readonly StatusMeta[] = [
  { status: 'backlog', title: 'Бэклог', shortTitle: 'Backlog', description: '', icon: '○', severity: 'secondary', owner: 'both', agentGuidance: '' },
  { status: 'planning', title: 'Планирование', shortTitle: 'Planning', description: '', icon: '◇', severity: 'info', owner: 'agent', agentGuidance: '' },
  { status: 'questions', title: 'Вопросы', shortTitle: 'Questions', description: '', icon: '?', severity: 'warn', owner: 'agent', agentGuidance: '' },
  { status: 'ready', title: 'Готово к работе', shortTitle: 'Ready', description: '', icon: '✦', severity: 'success', owner: 'both', agentGuidance: '' },
  { status: 'in_progress', title: 'В работе', shortTitle: 'In Progress', description: '', icon: '▶', severity: 'info', owner: 'agent', agentGuidance: '' },
  { status: 'testing', title: 'Тестирование', shortTitle: 'Testing', description: '', icon: '✓', severity: 'warn', owner: 'agent', agentGuidance: '' },
  { status: 'review', title: 'Готово к проверке', shortTitle: 'Review', description: '', icon: '◎', severity: 'warn', owner: 'agent', agentGuidance: '' },
  { status: 'done', title: 'Готово', shortTitle: 'Done', description: '', icon: '✔', severity: 'success', owner: 'user', agentGuidance: '' },
];

export interface FeatureGroup {
  readonly feature: TaskSummary;
  readonly subtasks: readonly TaskSummary[];
}

/** Центральное состояние UI: загрузка данных, фильтры и открытая карточка. */
@Injectable({ providedIn: 'root' })
export class TrackerStore {
  private readonly api = inject(TrackerApiService);
  private readonly sorting = inject(BoardSortService);
  private readonly search$ = new Subject<void>();

  /** Подписи задач прошлого опроса: по ним переиспользуются неизменившиеся объекты. */
  private readonly taskSignatures = new Map<string, string>();
  /** Подпись всего списка задач: если совпала — опрос ничего не меняет. */
  private tasksSignature: string | null = null;
  /** Идёт перетаскивание карточки: опрос на это время замирает. */
  private readonly draggingSignal = signal(false);

  private readonly tasksSignal = signal<readonly TaskSummary[]>([]);
  private readonly metaSignal = signal<TrackerMeta | null>(null);
  private readonly tagsSignal = signal<readonly Tag[]>([]);
  private readonly querySignal = signal('');
  private readonly searchScopesSignal = signal<readonly SearchScope[]>([...DEFAULT_SEARCH_SCOPES]);
  private readonly statusFilterSignal = signal<TaskStatus | null>(null);
  private readonly typeFilterSignal = signal<TaskType | null>(null);
  private readonly tagFilterSignal = signal<string | null>(null);
  private readonly featureFilterSignal = signal<string | null>(null);
  private readonly openTaskSignal = signal<TaskCard | null>(null);
  private readonly loadingSignal = signal(false);
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private readonly expandedFeaturesSignal = signal<readonly string[]>([]);
  private readonly onlineSignal = signal(true);
  private readonly backupsSignal = signal<readonly BackupRecord[]>([]);
  private readonly backupInfoSignal = signal<{
    directory: string;
    keep: number;
    autoEnabled: boolean;
    intervalHours: number;
  } | null>(null);

  public readonly tasks = this.tasksSignal.asReadonly();
  public readonly meta = this.metaSignal.asReadonly();
  public readonly tags = this.tagsSignal.asReadonly();
  public readonly query = this.querySignal.asReadonly();
  public readonly searchScopes = this.searchScopesSignal.asReadonly();
  public readonly statusFilter = this.statusFilterSignal.asReadonly();
  public readonly typeFilter = this.typeFilterSignal.asReadonly();
  public readonly tagFilter = this.tagFilterSignal.asReadonly();
  public readonly featureFilter = this.featureFilterSignal.asReadonly();
  public readonly openTask = this.openTaskSignal.asReadonly();
  public readonly loading = this.loadingSignal.asReadonly();
  public readonly busy = this.busySignal.asReadonly();
  public readonly error = this.errorSignal.asReadonly();
  public readonly online = this.onlineSignal.asReadonly();
  public readonly backups = this.backupsSignal.asReadonly();
  public readonly backupInfo = this.backupInfoSignal.asReadonly();
  public readonly dragging = this.draggingSignal.asReadonly();

  public readonly appName = computed(() => this.metaSignal()?.app.name ?? 'simple-ai-tracker');
  public readonly idPrefix = computed(() => this.metaSignal()?.app.idPrefix ?? 'SAT');
  public readonly statuses = computed<readonly StatusMeta[]>(() => this.metaSignal()?.statuses ?? FALLBACK_STATUSES);

  /** Задачи с учётом фильтра по фиче (сама фича и её подзадачи). */
  public readonly visibleTasks = computed<readonly TaskSummary[]>(() => {
    const filter = this.featureFilterSignal();
    const tasks = this.tasksSignal();
    if (!filter) return tasks;
    return tasks.filter((task) => task.id === filter || task.parentId === filter);
  });

  public readonly features = computed(() => this.tasksSignal().filter((task) => task.type === 'feature'));

  /** Задачи, сгруппированные по статусу, в порядке position. */
  public readonly tasksByStatus = computed<ReadonlyMap<TaskStatus, readonly TaskSummary[]>>(() => {
    const map = new Map<TaskStatus, TaskSummary[]>();
    for (const status of this.statuses()) map.set(status.status, []);
    for (const task of this.visibleTasks()) {
      const list = map.get(task.status);
      if (list) list.push(task);
    }
    for (const [status, list] of map) list.sort((a, b) => ColumnSorting.compare(a, b, this.sorting.mode(status)));
    return map;
  });

  /** Группы «фича → подзадачи» по статусу (для иерархического канбана). */
  public readonly featureGroupsByStatus = computed<ReadonlyMap<TaskStatus, readonly FeatureGroup[]>>(() => {
    const tasks = this.visibleTasks();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const expanded = new Set(this.expandedFeaturesSignal());
    const result = new Map<TaskStatus, FeatureGroup[]>();
    for (const status of this.statuses()) result.set(status.status, []);
    const handled = new Set<string>();

    for (const task of tasks) {
      if (task.type === 'feature' || !task.parentId) continue;
      const feature = byId.get(task.parentId);
      if (!feature) continue;
      if (feature.status !== task.status) continue;
      handled.add(task.id);
    }

    for (const feature of tasks) {
      if (feature.type !== 'feature') continue;
      const subtasks = tasks
        .filter((task) => task.parentId === feature.id && handled.has(task.id))
        .sort((a, b) => ColumnSorting.compare(a, b, this.sorting.mode(feature.status)));
      if (subtasks.length === 0) continue;
      const groups = result.get(feature.status);
      if (groups) groups.push({ feature, subtasks });
    }

    for (const [status, groups] of result) groups.sort((a, b) => ColumnSorting.compare(a.feature, b.feature, this.sorting.mode(status)));
    return result;
  });

  public readonly standaloneTasksByStatus = computed<ReadonlyMap<TaskStatus, readonly TaskSummary[]>>(() => {
    const tasks = this.visibleTasks();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const expanded = new Set(this.expandedFeaturesSignal());
    const result = new Map<TaskStatus, TaskSummary[]>();
    for (const status of this.statuses()) result.set(status.status, []);

    for (const task of tasks) {
      if (task.type !== 'feature') {
        const parent = task.parentId ? byId.get(task.parentId) : undefined;
        // Подзадача показывается отдельно, если её фича не в этом статусе или фича свёрнута.
        if (parent && parent.status === task.status && expanded.has(parent.id)) continue;
      }
      const list = result.get(task.status);
      if (list) list.push(task);
    }
    for (const [status, list] of result) list.sort((a, b) => ColumnSorting.compare(a, b, this.sorting.mode(status)));
    return result;
  });

  public readonly counts = computed<Record<string, number>>(() => {
    const result: Record<string, number> = {};
    for (const task of this.visibleTasks()) result[task.status] = (result[task.status] ?? 0) + 1;
    return result;
  });

  /** Быстрый доступ к карточке по id: карточки доски ищут родителя на каждой проверке. */
  public readonly tasksById = computed<ReadonlyMap<string, TaskSummary>>(
    () => new Map(this.tasksSignal().map((task) => [task.id, task])),
  );

  public readonly totalTasks = computed(() => this.tasksSignal().length);
  public readonly filtersActive = computed(
    () =>
      this.querySignal().trim().length > 0 ||
      this.statusFilterSignal() !== null ||
      this.typeFilterSignal() !== null ||
      this.tagFilterSignal() !== null,
  );

  public constructor() {
    this.search$.pipe(debounceTime(220)).subscribe(() => this.refresh());
  }

  public async init(): Promise<void> {
    const meta = await new Promise<TrackerMeta | null>((resolve) => {
      this.api.getMeta().subscribe({
        next: (value) => resolve(value),
        error: () => resolve(null),
      });
    });
    if (meta) this.metaSignal.set(meta);
    await Promise.all([this.refresh(), this.loadTags()]);
  }

  public async refresh(silent = false): Promise<void> {
    if (!silent) this.loadingSignal.set(true);
    const filters: TaskFilters = {
      query: this.querySignal().trim() || undefined,
      scopes: this.searchScopesSignal(),
      status: this.statusFilterSignal() ?? undefined,
      type: this.typeFilterSignal() ?? undefined,
      tag: this.tagFilterSignal() ?? undefined,
      limit: 500,
    };

    await new Promise<void>((resolve) => {
      this.api.listTasks(filters).subscribe({
        next: (response) => {
          // Быстрый путь: данные не изменились — не трогаем сигнал и не пересчитываем
          // производные коллекции доски (это самый дорогой шаг опроса).
          const signature = JSON.stringify(response.tasks);
          if (signature !== this.tasksSignature) {
            this.tasksSignature = signature;
            this.tasksSignal.set(this.mergeTasks(response.tasks));
          }
          this.onlineSignal.set(true);
          this.errorSignal.set(null);
          resolve();
        },
        error: (error: unknown) => {
          this.onlineSignal.set(false);
          this.errorSignal.set(TrackerApiService.describeError(error));
          resolve();
        },
      });
    });
    if (!silent) this.loadingSignal.set(false);
  }

  /**
   * Переиспользует объекты неизменившихся карточек.
   *
   * Без этого каждый опрос раз в 4 секунды приносил новые объекты и доска
   * перерисовывала все карточки целиком — заметные рывки при перетаскивании.
   */
  private mergeTasks(incoming: readonly TaskSummary[]): readonly TaskSummary[] {
    const current = this.tasksSignal();
    const previous = new Map(current.map((task) => [task.id, task]));
    const signatures = new Map<string, string>();

    const merged = incoming.map((task) => {
      const signature = JSON.stringify(task);
      signatures.set(task.id, signature);
      const prior = previous.get(task.id);
      return prior && this.taskSignatures.get(task.id) === signature ? prior : task;
    });

    this.taskSignatures.clear();
    for (const [id, signature] of signatures) this.taskSignatures.set(id, signature);

    // Тот же массив — сигнал не оповестит подписчиков, лишней перерисовки не будет.
    const unchanged = merged.length === current.length && merged.every((task, index) => task === current[index]);
    return unchanged ? current : merged;
  }

  public async loadTags(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.api.listTags().subscribe({
        next: (response) => {
          this.tagsSignal.set(response.tags);
          resolve();
        },
        error: () => resolve(),
      });
    });
  }

  // ------------------------------------------------------------- бэкапы

  public async loadBackups(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.api.listBackups().subscribe({
        next: (response) => {
          this.backupsSignal.set(response.backups);
          this.backupInfoSignal.set({
            directory: response.directory,
            keep: response.keep,
            autoEnabled: response.autoEnabled,
            intervalHours: response.intervalHours,
          });
          resolve();
        },
        error: (error: unknown) => {
          this.errorSignal.set(TrackerApiService.describeError(error));
          resolve();
        },
      });
    });
  }

  public async createBackup(): Promise<BackupRecord | null> {
    return this.run(async () => {
      const response = await firstValueFrom(this.api.createBackup());
      await this.loadBackups();
      return response.backup;
    });
  }

  public async deleteBackup(name: string): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.deleteBackup(name));
      await this.loadBackups();
      return null;
    });
  }

  public backupDownloadUrl(name: string): string {
    return this.api.backupDownloadUrl(name);
  }

  public setQuery(query: string): void {
    this.querySignal.set(query);
    this.search$.next();
  }

  /** Переключает одно поле поиска (мультивыбор, как в прежнем UI). */
  public toggleSearchScope(scope: SearchScope): void {
    const current = this.searchScopesSignal();
    const next = current.includes(scope)
      ? current.length > 1
        ? current.filter((item) => item !== scope)
        : current
      : [...current, scope];
    this.searchScopesSignal.set(next);
    if (this.querySignal().trim()) this.search$.next();
  }

  public isScopeActive(scope: SearchScope): boolean {
    return this.searchScopesSignal().includes(scope);
  }

  public setSearchScopes(scopes: readonly SearchScope[]): void {
    if (scopes.length === 0) return;
    this.searchScopesSignal.set([...scopes]);
    if (this.querySignal().trim()) this.search$.next();
  }

  public readonly activeScopeOptions = computed(() =>
    SEARCH_SCOPE_OPTIONS.filter((option) => this.searchScopesSignal().includes(option.key)),
  );

  public setStatusFilter(status: TaskStatus | null): void {
    this.statusFilterSignal.set(status);
    void this.refresh();
  }

  public setTypeFilter(type: TaskType | null): void {
    this.typeFilterSignal.set(type);
    void this.refresh();
  }

  public setTagFilter(tag: string | null): void {
    this.tagFilterSignal.set(tag);
    void this.refresh();
  }

  public toggleTagFilter(tag: string): void {
    this.setTagFilter(this.tagFilterSignal() === tag ? null : tag);
  }

  /** Фильтр доски по конкретной фиче (вкл/выкл). */
  public toggleFeatureFilter(featureId: string): void {
    this.featureFilterSignal.set(this.featureFilterSignal() === featureId ? null : featureId);
  }

  /** Перемещает карточку на одну позицию вверх/вниз внутри её колонки. */
  public async moveInColumn(id: string, direction: 'up' | 'down'): Promise<void> {
    const task = this.tasksSignal().find((item) => item.id === id);
    if (!task) return;
    const column = this.visibleTasks()
      .filter((item) => item.status === task.status)
      .sort((a, b) => a.position - b.position || a.seq - b.seq);
    const index = column.findIndex((item) => item.id === id);
    const neighbour = direction === 'up' ? column[index - 1] : column[index + 1];
    if (!neighbour) return;

    await this.run(async () => {
      await firstValueFrom(
        this.api.moveTask(id, direction === 'up' ? { beforeId: neighbour.id } : { afterId: neighbour.id }),
      );
      await this.refresh();
      return null;
    });
  }

  public clearFilters(): void {
    this.querySignal.set('');
    this.statusFilterSignal.set(null);
    this.typeFilterSignal.set(null);
    this.tagFilterSignal.set(null);
    this.featureFilterSignal.set(null);
    void this.refresh();
  }

  public isFeatureExpanded(featureId: string): boolean {
    return this.expandedFeaturesSignal().includes(featureId);
  }

  public toggleFeature(featureId: string): void {
    const current = this.expandedFeaturesSignal();
    this.expandedFeaturesSignal.set(
      current.includes(featureId) ? current.filter((id) => id !== featureId) : [...current, featureId],
    );
  }

  // ------------------------------------------------------------- карточки

  public async openCard(id: string): Promise<void> {
    this.busySignal.set(true);
    await new Promise<void>((resolve) => {
      this.api.getTask(id).subscribe({
        next: (response) => {
          this.openTaskSignal.set(response.task);
          this.errorSignal.set(null);
          resolve();
        },
        error: (error: unknown) => {
          this.errorSignal.set(TrackerApiService.describeError(error));
          resolve();
        },
      });
    });
    this.busySignal.set(false);
  }

  public closeCard(): void {
    this.openTaskSignal.set(null);
  }

  public async reloadOpenCard(): Promise<void> {
    const current = this.openTaskSignal();
    if (!current) return;
    await this.openCard(current.id);
  }

  public async createTask(payload: CreateTaskPayload): Promise<TaskCard | null> {
    return this.run(async () => {
      const response = await firstValueFrom(this.api.createTask(payload));
      await this.refresh();
      await this.loadTags();
      return response.task;
    });
  }

  public async updateTask(id: string, payload: UpdateTaskPayload): Promise<TaskCard | null> {
    return this.run(async () => {
      const response = await firstValueFrom(this.api.updateTask(id, payload));
      this.openTaskSignal.set(response.task);
      await this.refresh();
      await this.loadTags();
      return response.task;
    });
  }

  public async deleteTask(id: string): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.deleteTask(id));
      if (this.openTaskSignal()?.id === id) this.openTaskSignal.set(null);
      await this.refresh();
      return null;
    });
  }

  public async setTaskStatus(id: string, status: TaskStatus, comment?: string): Promise<void> {
    await this.run(async () => {
      const response = await firstValueFrom(this.api.setStatus(id, status, comment));
      if (this.openTaskSignal()?.id === id) this.openTaskSignal.set(response.task);
      await this.refresh();
      return null;
    });
  }

  public async moveTask(
    id: string,
    target: { status?: TaskStatus; beforeId?: string; afterId?: string },
  ): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.moveTask(id, target));
      await this.refresh();
      return null;
    });
  }

  /** Загружает скриншот и возвращает ссылку (для формы карточки). */
  public async uploadImage(dataUrl: string): Promise<string | null> {
    return this.run(async () => {
      const response = await firstValueFrom(this.api.uploadImage(dataUrl));
      return response.url;
    });
  }

  /** Прикладывает файл (например .md-план, добавленный пользователем). */
  public async attachFile(id: string, name: string, content: string): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.addAttachment(id, { name, content, kind: name.endsWith('.md') ? 'plan' : 'file' }));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  /** Удаляет вложение карточки. */
  public async deleteAttachment(id: string, attachmentId: number): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.deleteAttachment(id, attachmentId));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  public async addComment(id: string, text: string): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.addComment(id, text));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  public async askQuestions(id: string, questions: readonly string[], phase: QuestionPhase): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.askQuestions(id, questions, phase));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  public async deleteQuestion(id: string, questionId: number): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.deleteQuestion(id, questionId));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  public async answerQuestion(id: string, questionId: number, answer: string): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.answerQuestion(id, questionId, answer));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  public async attachPlan(
    id: string,
    payload: { content: string; name?: string; summary?: string; questions?: readonly string[] },
  ): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.attachPlan(id, payload));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  public async recordClarification(
    id: string,
    payload: { clarification: string; reason?: string; impact?: string; planChanged?: boolean; questions?: readonly string[] },
  ): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.recordClarification(id, payload));
      await this.reloadOpenCard();
      await this.refresh();
      return null;
    });
  }

  public async linkTasks(id: string, linkedTaskId: string, relation: LinkRelation): Promise<void> {
    await this.run(async () => {
      const response = await firstValueFrom(this.api.linkTasks(id, linkedTaskId, relation));
      this.openTaskSignal.set(response.task);
      return null;
    });
  }

  public async unlinkTasks(id: string, linkedTaskId: string): Promise<void> {
    await this.run(async () => {
      const response = await firstValueFrom(this.api.unlinkTasks(id, linkedTaskId));
      this.openTaskSignal.set(response.task);
      return null;
    });
  }

  public async addTag(name: string, color?: string, description?: string): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.addTag(name, color, description));
      await this.loadTags();
      return null;
    });
  }

  public async deleteTag(name: string): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.deleteTag(name));
      if (this.tagFilterSignal() === name) this.tagFilterSignal.set(null);
      await Promise.all([this.loadTags(), this.refresh()]);
      return null;
    });
  }

  public getTaskById(id: string): TaskSummary | undefined {
    return this.tasksById().get(id);
  }

  /** Доска сообщает о начале/конце перетаскивания: опрос на это время не нужен. */
  public setDragging(active: boolean): void {
    if (this.draggingSignal() !== active) this.draggingSignal.set(active);
  }

  private async run<T>(operation: () => Promise<T>): Promise<T | null> {
    this.busySignal.set(true);
    try {
      const result = await operation();
      this.errorSignal.set(null);
      return result;
    } catch (error) {
      this.errorSignal.set(TrackerApiService.describeError(error));
      return null;
    } finally {
      this.busySignal.set(false);
    }
  }
}
