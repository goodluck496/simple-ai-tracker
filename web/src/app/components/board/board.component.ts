import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { BadgeModule } from 'primeng/badge';
import { ButtonModule } from 'primeng/button';
import { ChipModule } from 'primeng/chip';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import type { StatusMeta, TaskStatus, TaskSummary, TaskType } from '../../models/tracker.models';
import { TrackerStore, type FeatureGroup } from '../../services/tracker-store.service';
import { AUTOMATION_START_TASK_STATUSES } from '../../../../../shared/automation/contracts';

/** Подписи, иконки и severity типов задач для PrimeNG-бейджа карточки. */
const TYPE_LABELS: Readonly<Record<TaskType, string>> = {
  feature: 'фича',
  task: 'задача',
  bug: 'баг',
};

type TypeSeverity = 'info' | 'success' | 'danger';

const TYPE_SEVERITY: Readonly<Record<TaskType, TypeSeverity>> = {
  feature: 'info',
  task: 'success',
  bug: 'danger',
};

const TYPE_ICONS: Readonly<Record<TaskType, string>> = {
  feature: 'pi pi-star-fill',
  task: 'pi pi-bolt',
  bug: 'pi pi-exclamation-triangle',
};

/** Сколько карточек колонки отрисовывать сразу (остальные — по скроллу). */
const CARDS_PER_PAGE = 20;
/** Порог в пикселях от низа колонки, после которого догружаем следующую порцию. */
const INFINITE_SCROLL_THRESHOLD_PX = 120;

/** Тело колонки: если в нём есть вертикальный скролл, колесо работает как обычно. */
const COLUMN_BODY_SELECTOR = '.sat-col__body';
const SCROLL_EDGE_TOLERANCE_PX = 2;

/** Шаг перемещения задачи по упорядоченному списку статусов стора. */
const STATUS_STEP_PREVIOUS = -1;
const STATUS_STEP_NEXT = 1;

/** Атрибут карточки с id задачи: по нему вычисляется позиция сброса. */
const TASK_ID_ATTRIBUTE = 'data-task-id';

/** Доля высоты карточки: ниже этой границы сброс вставляет задачу после карточки. */
const DROP_MIDPOINT_RATIO = 0.5;

/** Атрибут колонки со статусом: по нему обработчики drag & drop находят приёмник. */
const COLUMN_STATUS_ATTRIBUTE = 'data-status';
const COLUMN_SELECTOR = '.sat-col';

/** Атрибут приглушённой карточки и слой подсветки колонки-приёмника. */
const DRAGGING_ATTRIBUTE = 'data-dragging';
const DROP_OVERLAY_SELECTOR = '.sat-col__drop';
/** Класс доски на время перетаскивания: hover-эффекты карточек отключены. */
const BOARD_DRAGGING_CLASS = 'sat-board--dragging';

/** Не догружать карточки чаще, чем раз в четверть секунды. */
const SCROLL_LOAD_THROTTLE_MS = 250;

/** Пустые срезы: без аллокации на каждой проверке шаблона. */
const EMPTY_GROUPS: readonly FeatureGroup[] = [];
const EMPTY_TASKS: readonly TaskSummary[] = [];

/** Что реально рисуется в колонке с учётом порционной отрисовки. */
interface ColumnView {
  readonly groups: readonly FeatureGroup[];
  readonly tasks: readonly TaskSummary[];
  readonly hidden: number;
}

/** Константы относительных дат (без сторонних библиотек). */
const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
const DAYS_PER_YEAR = 365;

/** Относительная дата обновления: «сегодня», «вчера», «5 дн. назад». */
function formatRelativeDate(isoDate: string, now: number = Date.now()): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return '';
  const days = Math.floor(Math.max(0, now - timestamp) / MS_PER_DAY);
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < DAYS_PER_MONTH) return `${days} дн. назад`;
  const months = Math.floor(days / DAYS_PER_MONTH);
  if (months < MONTHS_PER_YEAR) return `${months} мес. назад`;
  return `${Math.floor(days / DAYS_PER_YEAR)} г. назад`;
}

/**
 * Канбан-доска: 8 колонок по статусам стора, внутри — группы «фича → её подзадачи»
 * и одиночные карточки. Всё оформление контролов — PrimeNG (p-tag, p-chip, p-button),
 * горизонтальный скролл доски работает обычным колесом мыши.
 */
@Component({
  selector: 'sat-board',
  standalone: true,
  imports: [CommonModule, BadgeModule, ButtonModule, ChipModule, TagModule, TooltipModule],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardComponent implements AfterViewInit, OnDestroy {
  private readonly store = inject(TrackerStore);
  private readonly ngZone = inject(NgZone);

  /** Контейнер доски: горизонтальный скролл колесом мыши. */
  @ViewChild('boardScroll') private boardScrollRef?: ElementRef<HTMLDivElement>;

  private removeWheelListener?: () => void;
  private removeDragListeners?: () => void;
  private removeScrollListener?: () => void;

  /** Запрос на создание задачи (из колонки). */
  public readonly addRequested = output<{ status: TaskStatus }>();
  /** Запрос на создание подзадачи фичи (+Таск / +Баг). */
  public readonly addSubtaskRequested = output<{ parentId: string; type: TaskType }>();
  /** Запрос на удаление карточки с доски. */
  public readonly deleteRequested = output<{ id: string }>();
  public readonly startRequested = output<string>();
  public readonly automationPending = input<ReadonlySet<string>>(new Set());
  public automationReason(task: TaskSummary): string {
    if (this.automationPending().has(task.id)) return 'Задача отправляется в очередь.';
    if (task.openQuestionsCount) return 'Сначала ответьте на вопросы в карточке.';
    if (!AUTOMATION_START_TASK_STATUSES.includes(task.status)) return 'Новый запуск доступен из backlog, planning или ready. Текущий запуск можно продолжить в очереди.';
    return '';
  }
  public onStart(event: Event, task: TaskSummary): void {
    event.stopPropagation();
    if (!this.automationReason(task)) this.startRequested.emit(task.id);
  }

  public readonly statuses = this.store.statuses;
  public readonly counts = this.store.counts;
  public readonly featureGroupsByStatus = this.store.featureGroupsByStatus;
  public readonly standaloneTasksByStatus = this.store.standaloneTasksByStatus;

  /**
   * id перетаскиваемой задачи — приватное состояние нативного HTML5 drag & drop.
   *
   * Подсветка карточки и колонки-приёмника делается прямыми классами на DOM,
   * без сигналов: иначе каждое событие перетаскивания запускало проверку всего
   * шаблона доски и появлялись рывки.
   */
  private draggedId: string | null = null;
  private draggedElement: HTMLElement | null = null;
  private dropColumn: HTMLElement | null = null;

  /** Подписи статусов — один раз на метаданные, а не поиском в шаблоне. */
  private readonly statusTitles = computed<ReadonlyMap<TaskStatus, string>>(
    () => new Map(this.statuses().map((meta) => [meta.status, meta.title])),
  );
  private readonly statusShorts = computed<ReadonlyMap<TaskStatus, string>>(
    () => new Map(this.statuses().map((meta) => [meta.status, meta.shortTitle])),
  );

  // ------------------------------------------------------------ выборки колонки

  /** Группы «фича → подзадачи» для колонки. */
  public featureGroups(status: TaskStatus): readonly FeatureGroup[] {
    return this.featureGroupsByStatus().get(status) ?? EMPTY_GROUPS;
  }

  /** Одиночные карточки колонки (обычные задачи, фичи, развёрнутые подзадачи вне группы). */
  public columnTasks(status: TaskStatus): readonly TaskSummary[] {
    return this.standaloneTasksByStatus().get(status) ?? EMPTY_TASKS;
  }

  public countOf(status: TaskStatus): number {
    return this.counts()[status] ?? 0;
  }

  /** Колонка пуста, если в ней нет ни групп, ни одиночных карточек. */
  public isEmptyColumn(status: TaskStatus): boolean {
    return this.featureGroups(status).length === 0 && this.columnTasks(status).length === 0;
  }

  /** Классы колонки: базовый и цветовая полоса статуса. */
  public columnClasses(status: StatusMeta): string[] {
    return ['sat-col', `sat-col--${status.status}`];
  }

  // ------------------------------------------------------------------- карточка

  public typeLabel(type: TaskType): string {
    return TYPE_LABELS[type];
  }

  public typeIcon(type: TaskType): string {
    return TYPE_ICONS[type];
  }

  public typeSeverity(type: TaskType): TypeSeverity {
    return TYPE_SEVERITY[type];
  }

  public updatedLabel(task: TaskSummary): string {
    return formatRelativeDate(task.updatedAt);
  }

  /** Есть ли что показывать в строке бейджей. */
  public hasBadges(task: TaskSummary): boolean {
    return (
      task.openQuestionsCount > 0 ||
      task.hasPlan ||
      task.requiresManualTest ||
      task.commentsCount > 0 ||
      task.attachmentsCount > 0 ||
      task.subtasksCount > 0
    );
  }

  public hasTags(task: TaskSummary): boolean {
    return task.tags.length > 0;
  }

  public onCardClick(id: string): void {
    void this.store.openCard(id);
  }

  /** Enter на самой карточке (не на вложенной кнопке) открывает её. */
  public onCardActivate(event: Event, id: string): void {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    this.onCardClick(id);
  }

  public onTagClick(event: Event, tagName: string): void {
    event.stopPropagation();
    this.store.toggleTagFilter(tagName);
  }

  // ------------------------------------------------------------ группы фич

  public isExpanded(featureId: string): boolean {
    return this.store.isFeatureExpanded(featureId);
  }

  public onToggleFeature(event: Event, featureId: string): void {
    event.stopPropagation();
    this.store.toggleFeature(featureId);
  }

  /** Количество готовых (done) подзадач в группе. */
  public doneSubtasks(group: FeatureGroup): number {
    return group.subtasks.filter((subtask) => subtask.status === 'done').length;
  }

  // --------------------------------------------------- быстрое перемещение

  /** Предыдущий статус по порядку стора либо null для первого. */
  public previousStatus(status: TaskStatus): TaskStatus | null {
    return this.shiftedStatus(status, STATUS_STEP_PREVIOUS);
  }

  /** Следующий статус по порядку стора либо null для последнего. */
  public nextStatus(status: TaskStatus): TaskStatus | null {
    return this.shiftedStatus(status, STATUS_STEP_NEXT);
  }

  public statusTitle(status: TaskStatus): string {
    return this.statusTitles().get(status) ?? status;
  }

  public onShiftClick(event: Event, task: TaskSummary, target: TaskStatus): void {
    event.stopPropagation();
    void this.store.setTaskStatus(task.id, target);
  }

  private shiftedStatus(status: TaskStatus, step: number): TaskStatus | null {
    const list = this.store.statuses();
    const index = list.findIndex((meta) => meta.status === status);
    if (index < 0) return null;
    const targetIndex = index + step;
    if (targetIndex < 0 || targetIndex >= list.length) return null;
    return list[targetIndex].status;
  }

  // ------------------------------------------------------------- создание

  /**
   * Новые карточки появляются только в бэклоге: остальные колонки — про перемещение
   * между статусами, а не про создание.
   */
  public canCreateInColumn(status: TaskStatus): boolean {
    return status === 'backlog';
  }

  /** Запрос на создание задачи — уходит наверх через addRequested. */
  public onQuickAdd(status: TaskStatus): void {
    if (!this.canCreateInColumn(status)) return;
    this.addRequested.emit({ status: 'backlog' });
  }

  // ------------------------------------------- горизонтальный скролл колесом

  public ngAfterViewInit(): void {
    const container = this.boardScrollRef?.nativeElement;
    if (!container) return;

    // Вне Angular-зоны: колесо не должно запускать change detection.
    this.ngZone.runOutsideAngular(() => {
      const onWheel = (event: WheelEvent): void => {
        // Shift+wheel и горизонтальный трекпад оставляем браузеру.
        if (event.shiftKey) return;
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

        // Колонку, у которой ещё есть вертикальный скролл, крутим как обычно.
        const target = event.target as HTMLElement | null;
        const columnBody = target?.closest(COLUMN_BODY_SELECTOR) as HTMLElement | null;
        if (columnBody) {
          const canScrollDown =
            event.deltaY > 0 &&
            columnBody.scrollTop + columnBody.clientHeight < columnBody.scrollHeight - SCROLL_EDGE_TOLERANCE_PX;
          const canScrollUp = event.deltaY < 0 && columnBody.scrollTop > SCROLL_EDGE_TOLERANCE_PX;
          if (canScrollDown || canScrollUp) return;
        }

        container.scrollLeft += event.deltaY;
        event.preventDefault();
      };

      container.addEventListener('wheel', onWheel, { passive: false });
      this.removeWheelListener = () => container.removeEventListener('wheel', onWheel);
    });

    // Перетаскивание и скролл колонок: dragover/scroll приходят постоянно,
    // поэтому слушаем их вне зоны и заходим в неё только по делу.
    this.ngZone.runOutsideAngular(() => {
      this.bindDragListeners(container);
      this.bindScrollListeners(container);
    });
  }

  public ngOnDestroy(): void {
    this.removeWheelListener?.();
    this.removeDragListeners?.();
    this.removeScrollListener?.();
  }

  // --------------------------------------------- порционная отрисовка (lazy)

  /** Сколько карточек показывать в каждой колонке (id → лимит). */
  private readonly visibleCounts = signal<Record<string, number>>({});

  /**
   * Готовые к отрисовке срезы всех колонок.
   *
   * Считаются один раз на изменение данных и лимитов, а не на каждую проверку
   * шаблона: иначе перетаскивание карточки пересобирало срезы всех восьми колонок
   * на каждый кадр.
   */
  private readonly columnViews = computed<ReadonlyMap<TaskStatus, ColumnView>>(() => {
    const limits = this.visibleCounts();
    const groupsByStatus = this.featureGroupsByStatus();
    const tasksByStatus = this.standaloneTasksByStatus();
    const result = new Map<TaskStatus, ColumnView>();

    for (const meta of this.statuses()) {
      const status = meta.status;
      const limit = limits[status] ?? CARDS_PER_PAGE;
      const allGroups = groupsByStatus.get(status) ?? EMPTY_GROUPS;
      const allTasks = tasksByStatus.get(status) ?? EMPTY_TASKS;

      // Фича «стоит» одну единицу бюджета, каждая её подзадача — тоже одну.
      let budget = limit;
      const groups: FeatureGroup[] = [];
      for (const group of allGroups) {
        if (budget <= 0) break;
        budget -= 1;
        const subtasks = group.subtasks.slice(0, Math.max(0, budget));
        budget -= subtasks.length;
        groups.push({ feature: group.feature, subtasks });
      }

      // Одиночным карточкам достаётся остаток после всех групп колонки.
      const allSubtasksCount = allGroups.reduce((sum, group) => sum + group.subtasks.length, 0);
      const remaining = Math.max(0, limit - allGroups.length - allSubtasksCount);
      const tasks = allTasks.slice(0, remaining);

      const total = allGroups.length + allTasks.length;
      const shown = groups.length + tasks.length;
      result.set(status, { groups, tasks, hidden: Math.max(0, total - shown) });
    }

    return result;
  });

  /** Группы фич с учётом лимита порционной отрисовки. */
  public visibleFeatureGroups(status: TaskStatus): readonly FeatureGroup[] {
    return this.columnViews().get(status)?.groups ?? EMPTY_GROUPS;
  }

  /** Одиночные карточки колонки в пределах остатка бюджета. */
  public visibleColumnTasks(status: TaskStatus): readonly TaskSummary[] {
    return this.columnViews().get(status)?.tasks ?? EMPTY_TASKS;
  }

  /** Сколько карточек колонки ещё не отрисовано. */
  public hiddenCount(status: TaskStatus): number {
    return this.columnViews().get(status)?.hidden ?? 0;
  }

  /** Догружает следующую порцию карточек колонки. */
  public loadMore(status: TaskStatus): void {
    this.visibleCounts.update((current) => ({
      ...current,
      [status]: (current[status] ?? CARDS_PER_PAGE) + CARDS_PER_PAGE,
    }));
  }

  /** Сбрасывает лимиты (например, при смене фильтров). */
  public resetPaging(): void {
    this.visibleCounts.set({});
  }

  // -------------------------------------------------- группировка и фильтр

  /** Короткая подпись статуса для бейджа группы фичи. */
  public statusShort(status: TaskStatus): string {
    const short = this.statusShorts().get(status);
    return short ? short.slice(0, 4) : status;
  }

  /** Процент готовых подзадач фичи (для полоски прогресса). */
  public featurePercent(group: FeatureGroup): number {
    if (group.subtasks.length === 0) return 0;
    return Math.round((this.doneSubtasks(group) / group.subtasks.length) * 100);
  }

  /** Активен ли фильтр доски по этой фиче. */
  public isFeatureFiltered(featureId: string): boolean {
    return this.store.featureFilter() === featureId;
  }

  /** Клик по фильтру фичи: включает/снимает фильтрацию доски по фиче. */
  public onFeatureFilterTrigger(event: Event, featureId: string): void {
    event.stopPropagation();
    this.store.toggleFeatureFilter(featureId);
  }

  /** Родительская фича карточки (для чипа «под фичей»). */
  public parentOf(task: TaskSummary): TaskSummary | undefined {
    if (!task.parentId) return undefined;
    return this.store.getTaskById(task.parentId);
  }

  /** Подсказка по вопросам карточки. */
  public questionsTooltip(task: TaskSummary): string {
    return task.openQuestionsCount > 0
      ? `Открытых вопросов: ${task.openQuestionsCount}. Агент ждёт ответов.`
      : `Вопросов: ${task.questionsCount}`;
  }

  /** Подсказка по вложениям карточки. */
  public planTooltip(task: TaskSummary): string {
    return task.hasPlan
      ? `Планы и вложения: ${task.attachmentsCount} (план v${task.currentPlanVersion})`
      : `Планы и вложения: ${task.attachmentsCount}`;
  }

  /** Первая карточка в колонке статуса (для disabled «вверх»). */
  public isFirstInColumn(task: TaskSummary): boolean {
    const column = this.columnTasks(task.status);
    return column.length === 0 || column[0].id === task.id;
  }

  /** Последняя карточка в колонке статуса (для disabled «вниз»). */
  public isLastInColumn(task: TaskSummary): boolean {
    const column = this.columnTasks(task.status);
    return column.length === 0 || column[column.length - 1].id === task.id;
  }

  public onMoveOrder(event: Event, task: TaskSummary, direction: 'up' | 'down'): void {
    event.stopPropagation();
    void this.store.moveInColumn(task.id, direction);
  }

  public onEdit(event: Event, task: TaskSummary): void {
    event.stopPropagation();
    void this.store.openCard(task.id);
  }

  public onDelete(event: Event, task: TaskSummary): void {
    event.stopPropagation();
    this.deleteRequested.emit({ id: task.id });
  }

  public onAddSubtask(event: Event, parentId: string, type: TaskType): void {
    event.stopPropagation();
    this.addSubtaskRequested.emit({ parentId, type });
  }

  // ------------------------------------------------------ drag & drop (HTML5)

  public onDragStart(event: DragEvent, task: TaskSummary): void {
    this.draggedId = task.id;
    const element = event.currentTarget;
    if (element instanceof HTMLElement) {
      element.setAttribute(DRAGGING_ATTRIBUTE, 'true');
      this.draggedElement = element;
    }
    // Пока тащим — гасим hover-эффекты карточек и замираем опрос доски
    this.boardScrollRef?.nativeElement.classList.add(BOARD_DRAGGING_CLASS);
    this.store.setDragging(true);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', task.id);
      this.setDragGhost(event.dataTransfer, task);
    }
  }

  /**
   * Своя «тень» перетаскивания: компактная плашка вместо снимка всей карточки.
   * Снимок большой карточки браузер перерисовывает под курсором каждый кадр —
   * на больших экранах это заметно подтормаживает.
   */
  private setDragGhost(transfer: DataTransfer, task: TaskSummary): void {
    const ghost = document.createElement('div');
    ghost.className = 'sat-drag-ghost';
    ghost.textContent = `${task.id} · ${task.title}`;
    document.body.appendChild(ghost);
    try {
      transfer.setDragImage(ghost, 14, 18);
    } finally {
      // Браузер снимает копию синхронно — сам элемент в документе держать не нужно
      setTimeout(() => ghost.remove(), 0);
    }
  }

  public onDragEnd(): void {
    this.draggedId = null;
    this.draggedElement?.removeAttribute(DRAGGING_ATTRIBUTE);
    this.draggedElement = null;
    this.highlightColumn(null);
    this.boardScrollRef?.nativeElement.classList.remove(BOARD_DRAGGING_CLASS);
    this.store.setDragging(false);
  }

  /** Подсветка колонки-приёмника: меняем opacity одного слоя, без классов и проверки шаблона. */
  private highlightColumn(column: HTMLElement | null): void {
    if (this.dropColumn === column) return;
    this.overlayOf(this.dropColumn)?.style.setProperty('opacity', '0');
    this.dropColumn = column;
    this.overlayOf(column)?.style.setProperty('opacity', '1');
  }

  private overlayOf(column: HTMLElement | null): HTMLElement | null {
    return column?.querySelector<HTMLElement>(DROP_OVERLAY_SELECTOR) ?? null;
  }

  /**
   * Обработчики `dragover` / `dragleave` / `drop` живут вне Angular-зоны и меняют
   * только DOM-классы.
   *
   * `dragover` приходит десятки раз в секунду, а `dragenter`/`dragleave` — на каждой
   * границе элементов. Раньше каждый такой вызов запускал проверку всего шаблона
   * доски, и при перетаскивании интерфейс заметно подтормаживал.
   */
  private bindDragListeners(container: HTMLElement): void {
    const columnOf = (event: Event): { element: HTMLElement; status: TaskStatus } | null => {
      const target = event.target;
      if (!(target instanceof Element)) return null;
      const element = target.closest(COLUMN_SELECTOR);
      if (!(element instanceof HTMLElement)) return null;
      const status = element.getAttribute(COLUMN_STATUS_ATTRIBUTE) as TaskStatus | null;
      return status ? { element, status } : null;
    };

    const onDragOver = (event: DragEvent): void => {
      if (this.draggedId === null) return;
      const column = columnOf(event);
      if (!column) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.highlightColumn(column.element);
    };

    const onDragLeave = (event: DragEvent): void => {
      if (this.draggedId === null) return;
      // Курсор остался внутри доски (например, в зазоре между колонками) — подсветку
      // не снимаем: иначе при движении по границе она мигает и вызывает перерисовки.
      const next = event.relatedTarget;
      if (next instanceof Node && container.contains(next)) return;
      this.highlightColumn(null);
    };

    const onDrop = (event: DragEvent): void => {
      const column = columnOf(event);
      event.preventDefault();
      const draggedId = this.draggedId;
      this.highlightColumn(null);
      if (!column || draggedId === null) {
        this.ngZone.run(() => this.onDragEnd());
        return;
      }
      const afterId = this.resolveAfterId(event, draggedId, column.element);
      const status = column.status;
      this.ngZone.run(() => {
        this.onDragEnd();
        void this.store.moveTask(draggedId, { status, afterId });
      });
    };

    container.addEventListener('dragover', onDragOver, { passive: false });
    container.addEventListener('dragleave', onDragLeave, true);
    container.addEventListener('drop', onDrop);
    this.removeDragListeners = () => {
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('dragleave', onDragLeave, true);
      container.removeEventListener('drop', onDrop);
    };
  }

  /**
   * Бесконечный скролл колонок — тоже вне зоны: `scroll` приходит постоянно,
   * а догрузка порции идёт не чаще `SCROLL_LOAD_THROTTLE_MS`.
   */
  private bindScrollListeners(container: HTMLElement): void {
    let lastLoad = 0;

    const onScroll = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const column = target.closest(COLUMN_SELECTOR);
      const status = column?.getAttribute(COLUMN_STATUS_ATTRIBUTE) as TaskStatus | null;
      if (!status) return;

      const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceToBottom > INFINITE_SCROLL_THRESHOLD_PX) return;
      if (this.hiddenCount(status) <= 0) return;

      const now = Date.now();
      if (now - lastLoad < SCROLL_LOAD_THROTTLE_MS) return;
      lastLoad = now;
      this.ngZone.run(() => this.loadMore(status));
    };

    // scroll не всплывает — слушаем на фазе перехвата
    container.addEventListener('scroll', onScroll, true);
    this.removeScrollListener = () => container.removeEventListener('scroll', onScroll, true);
  }

  /**
   * Карточка, после которой нужно вставить задачу: последняя карточка, середина
   * которой выше курсора. Если таких нет — undefined (перемещение в конец колонки).
   */
  private resolveAfterId(event: DragEvent, draggedId: string, container: HTMLElement): string | undefined {
    const cards = container.querySelectorAll<HTMLElement>(`[${TASK_ID_ATTRIBUTE}]`);
    let afterId: string | undefined;
    for (const card of Array.from(cards)) {
      const id = card.getAttribute(TASK_ID_ATTRIBUTE);
      if (id === null || id === draggedId) continue;
      const rect = card.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height * DROP_MIDPOINT_RATIO) break;
      afterId = id;
    }
    return afterId;
  }
}
