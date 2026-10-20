import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type {
  LinkRelation,
  TaskCard,
  TaskAttachment,
  TaskStatus,
  TaskSummary,
  TaskType,
} from '../../models/tracker.models';
import { COMMENT_KIND_LABELS, LINK_RELATION_OPTIONS } from '../../models/tracker.models';
import { AccordionModule } from 'primeng/accordion';
import { AutoCompleteModule, type AutoCompleteCompleteEvent } from 'primeng/autocomplete';
import { BadgeModule } from 'primeng/badge';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { ChipModule } from 'primeng/chip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DialogModule } from 'primeng/dialog';
import { ImageModule } from 'primeng/image';
import { MessageModule } from 'primeng/message';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { ConfirmationService } from 'primeng/api';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TabsModule } from 'primeng/tabs';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';
import { escapeHtml, renderMarkdown } from '../../shared/markdown';
import { TrackerStore } from '../../services/tracker-store.service';
import { formatBytes, formatDateTime, formatRelative } from '../../shared/format';
import { PlanViewerComponent } from '../plan-viewer/plan-viewer.component';
import { DecisionLogComponent } from '../decision-log/decision-log.component';
import { QuestionsPanelComponent } from '../questions-panel/questions-panel.component';

type DialogTab = 'overview' | 'plan' | 'questions' | 'discussion' | 'relations';

/** Ширина сайдбара: как в прежнем UI (тянется за левую границу, запоминается). */
const SIDEBAR_DEFAULT_WIDTH = 720;
const SIDEBAR_MIN_WIDTH = 420;
const SIDEBAR_WIDTH_KEY = 'simple_ai_tracker_sidebar_width';

function readStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= SIDEBAR_MIN_WIDTH) return stored;
  } catch {
    // localStorage недоступен — используем значение по умолчанию
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

interface TabDefinition {
  readonly id: DialogTab;
  readonly label: string;
  readonly badge: number | null;
}

/**
 * Карточка задачи: просмотр и редактирование всех аспектов — описания, тегов,
 * плана (с версиями), вопросов, обсуждения, журнала решений и связей.
 */
@Component({
  selector: 'sat-task-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AccordionModule,
    AutoCompleteModule,
    BadgeModule,
    ButtonModule,
    CheckboxModule,
    ChipModule,
    ConfirmDialogModule,
    InputTextModule,
    DialogModule,
    ImageModule,
    MessageModule,
    SelectModule,
    TabsModule,
    TagModule,
    TextareaModule,
    ToggleButtonModule,
    TooltipModule,
    PlanViewerComponent,
    DecisionLogComponent,
    QuestionsPanelComponent,
  ],
  providers: [ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-dialog.component.html',
  styleUrl: './task-dialog.component.scss',
})
export class TaskDialogComponent {
  public readonly store = inject(TrackerStore);
  private readonly confirmation = inject(ConfirmationService);

  public readonly task = input<TaskCard | null>(null);
  public readonly createMode = input(false);
  public readonly createType = input<TaskType>('task');
  public readonly createStatus = input<TaskStatus>('backlog');
  public readonly parentId = input<string | null>(null);

  public readonly closed = output<void>();

  public readonly tab = signal<DialogTab>('overview');

  /** PrimeNG p-tabs отдаёт значение как string | number — приводим к типу вкладки. */
  public onTabChange(value: string | number | undefined): void {
    if (typeof value === 'string') {
      this.tab.set(value as DialogTab);
    }
  }

  /** Ширина выдвижного сайдбара (запоминается в localStorage). */
  public readonly sidebarWidth = signal(readStoredWidth());
  public readonly isExpanded = signal(false);
  public readonly isResizing = signal(false);

  private widthBeforeExpand = 0;

  public readonly title = signal('');
  public readonly description = signal('');
  public readonly type = signal<TaskType>('task');
  public readonly status = signal<TaskStatus>('backlog');
  public readonly requiresManualTest = signal(false);
  public readonly tags = signal<readonly string[]>([]);
  public readonly tagDraft = signal('');
  public readonly commentDraft = signal('');
  public readonly clarificationDraft = signal('');
  public readonly clarificationReason = signal('');
  public readonly clarificationImpact = signal('');
  public readonly clarificationPlanChanged = signal(false);
  public readonly clarificationQuestions = signal('');
  public readonly planDraft = signal('');
  public readonly planQuestions = signal('');
  public readonly planSummary = signal('');
  public readonly linkTargetId = signal('');
  public readonly linkRelation = signal<LinkRelation>('related');
  public readonly showPlanForm = signal(false);
  public readonly showClarificationForm = signal(false);
  public readonly error = signal<string | null>(null);

  /** Скриншоты формы (ссылки /api/images/...). */
  public readonly images = signal<string[]>([]);
  /** Вложения карточки (планы и документы). */
  public readonly attachments = signal<readonly TaskAttachment[]>([]);
  /** Перетаскивание файлов над зоной загрузки. */
  public readonly isDraggingFiles = signal(false);
  /** Открытое вложение в модалке предпросмотра. */
  public readonly preview = signal<{ name: string; content: string } | null>(null);

  public readonly previewHtml = computed(() => {
    const file = this.preview();
    if (!file) return '';
    return file.name.toLowerCase().endsWith('.md')
      ? renderMarkdown(file.content)
      : `<pre>${escapeHtml(file.content)}</pre>`;
  });

  private readonly lastSyncedTaskId = signal<string | null>(null);

  public constructor() {
    effect(() => {
      const card = this.task();
      untracked(() => {
        if (!card) {
          this.lastSyncedTaskId.set(null);
          return;
        }
        this.syncFrom(card);
      });
    });
  }

  public readonly isCreate = computed(() => this.createMode() || !this.task());
  public readonly statuses = computed(() => this.store.statuses());
  public readonly allTags = computed(() => this.store.tags());
  public readonly openQuestions = computed(() => this.task()?.openQuestionsCount ?? 0);

  public readonly tabs = computed<readonly TabDefinition[]>(() => [
    { id: 'overview', label: 'Обзор', badge: null },
    { id: 'plan', label: 'План', badge: this.task()?.planHistory.length ?? null },
    { id: 'questions', label: 'Вопросы', badge: this.openQuestions() || null },
    { id: 'discussion', label: 'Обсуждение', badge: this.task()?.comments.length ?? null },
    { id: 'relations', label: 'Связи', badge: this.task()?.links.length ?? null },
  ]);

  public readonly availableTasks = computed<TaskSummary[]>(() =>
    this.store.tasks().filter((candidate) => candidate.id !== this.task()?.id),
  );

  /** Заголовок выбранной цели связи: селект обрезает текст, полный — в тултипе. */
  public readonly linkTargetLabel = computed(
    () => this.availableTasks().find((candidate) => candidate.id === this.linkTargetId())?.title ?? '',
  );

  public readonly childTasks = computed<readonly TaskSummary[]>(() => {
    const card = this.task();
    if (!card) return [];
    const known = new Set(card.subtasks.map((subtask) => subtask.id));
    return [
      ...card.subtasks,
      ...this.store.tasks().filter((candidate) => candidate.parentId === card.id && !known.has(candidate.id)),
    ];
  });

  public readonly linkRows = computed(() => {
    const card = this.task();
    if (!card) return [];
    return card.links.map((link) => {
      const outgoing = link.taskId === card.id;
      const otherId = outgoing ? link.linkedTaskId : link.taskId;
      const other = this.store.getTaskById(otherId);
      return {
        linkId: link.id,
        otherId,
        title: other?.title ?? otherId,
        status: other?.status ?? null,
        relation: link.relation,
        outgoing,
      };
    });
  });

  public readonly statusMeta = computed(() => {
    const current = this.status();
    return this.statuses().find((meta) => meta.status === current) ?? null;
  });

  public commentKindLabel(kind: string): string {
    return COMMENT_KIND_LABELS[kind as keyof typeof COMMENT_KIND_LABELS] ?? kind;
  }

  public readonly relationOptions = [...LINK_RELATION_OPTIONS];

  public readonly typeOptions = [
    { label: 'Фича', value: 'feature' as TaskType },
    { label: 'Задача', value: 'task' as TaskType },
    { label: 'Баг', value: 'bug' as TaskType },
  ];

  public readonly statusOptions = computed<{ label: string; value: TaskStatus }[]>(() =>
    this.statuses().map((meta) => ({ label: meta.title, value: meta.status })),
  );
  public readonly formatDateTime = formatDateTime;
  public readonly formatRelative = formatRelative;
  public readonly formatBytes = formatBytes;

  // ------------------------------------------------------------------ формы

  public addTag(name: string): void {
    const normalized = name.trim().toLowerCase();
    if (!normalized) return;
    this.tags.update((current) => (current.includes(normalized) ? current : [...current, normalized]));
    this.tagDraft.set('');
  }

  /** Подсказки тегов для автокомплита (PrimeNG p-autocomplete). */
  public readonly tagSuggestions = signal<{ name: string }[]>([]);

  public filterTagSuggestions(event: AutoCompleteCompleteEvent): void {
    const query = event.query.trim().toLowerCase();
    this.tagSuggestions.set(
      this.store
        .tags()
        .filter((tag) => !this.tags().includes(tag.name))
        .filter((tag) => (query ? tag.name.includes(query) : true))
        .map((tag) => ({ name: tag.name })),
    );
  }

  public onTagSelected(event: { value?: { name: string } }): void {
    const name = event.value?.name;
    if (name) this.addTag(name);
  }

  /** Удаление карточки через PrimeNG ConfirmDialog. */
  public confirmRemove(): void {
    const card = this.task();
    if (!card) return;
    this.confirmation.confirm({
      header: 'Удаление карточки',
      message: `Удалить ${card.id} «${card.title}»? Действие необратимо.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Удалить',
      rejectLabel: 'Отмена',
      accept: () => void this.remove(),
    });
  }

  public removeTag(name: string): void {
    this.tags.update((current) => current.filter((tag) => tag !== name));
  }

  public onTypeChange(value: TaskType): void {
    this.type.set(value as TaskType);
  }

  public onStatusChange(value: TaskStatus): void {
    this.status.set(value as TaskStatus);
  }

  public async save(): Promise<void> {
    this.error.set(null);
    if (!this.title().trim()) {
      this.error.set('Название не может быть пустым.');
      return;
    }

    if (this.isCreate()) {
      const created = await this.store.createTask({
        title: this.title().trim(),
        type: this.type(),
        description: this.description(),
        status: this.status(),
        parentId: this.parentId(),
        tags: this.tags(),
        requiresManualTest: this.requiresManualTest(),
        images: this.images(),
      });
      if (!created) {
        this.error.set(this.store.error() ?? 'Не удалось создать задачу.');
        return;
      }
      // Файлы, приложенные до сохранения, догружаем к уже созданной карточке.
      for (const pending of this.pendingAttachments()) {
        await this.store.attachFile(created.id, pending.name, pending.content);
      }
      this.pendingAttachments.set([]);
      // После создания сразу показываем карточку в сайдбаре (как «Показать» в прежнем UI).
      await this.store.openCard(created.id);
      this.closed.emit();
      return;
    }

    const card = this.task();
    if (!card) return;
    const updated = await this.store.updateTask(card.id, {
      title: this.title().trim(),
      description: this.description(),
      type: this.type(),
      tags: this.tags(),
      requiresManualTest: this.requiresManualTest(),
      images: this.images(),
    });
    if (!updated) {
      this.error.set(this.store.error() ?? 'Не удалось сохранить изменения.');
      return;
    }
    this.lastSyncedTaskId.set(null);
  }

  public async changeStatus(status: TaskStatus): Promise<void> {
    const card = this.task();
    if (!card || status === card.status) return;
    await this.store.setTaskStatus(card.id, status);
    this.status.set(status);
  }

  public async remove(): Promise<void> {
    const card = this.task();
    if (!card) return;
    await this.store.deleteTask(card.id);
    this.closed.emit();
  }

  public async submitComment(): Promise<void> {
    const card = this.task();
    const text = this.commentDraft().trim();
    if (!card || !text) return;
    await this.store.addComment(card.id, text);
    this.commentDraft.set('');
  }

  public async submitClarification(): Promise<void> {
    const card = this.task();
    const clarification = this.clarificationDraft().trim();
    if (!card || !clarification) return;
    await this.store.recordClarification(card.id, {
      clarification,
      reason: this.clarificationReason().trim() || undefined,
      impact: this.clarificationImpact().trim() || undefined,
      planChanged: this.clarificationPlanChanged(),
      questions: this.clarificationQuestions()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    });
    this.clarificationDraft.set('');
    this.clarificationReason.set('');
    this.clarificationImpact.set('');
    this.clarificationQuestions.set('');
    this.clarificationPlanChanged.set(false);
    this.showClarificationForm.set(false);
    this.tab.set('discussion');
  }

  public async submitPlan(): Promise<void> {
    const card = this.task();
    const content = this.planDraft().trim();
    if (!card || !content) return;
    await this.store.attachPlan(card.id, {
      content,
      name: `plan-${card.id}.md`,
      summary: this.planSummary().trim() || undefined,
      questions: this.planQuestions()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    });
    this.planDraft.set('');
    this.planQuestions.set('');
    this.planSummary.set('');
    this.showPlanForm.set(false);
  }

  public async askQuestion(text: string): Promise<void> {
    const card = this.task();
    if (!card) return;
    await this.store.askQuestions(card.id, [text], 'implementation');
  }

  public async deleteQuestion(questionId: number): Promise<void> {
    const card = this.task();
    if (!card) return;
    await this.store.deleteQuestion(card.id, questionId);
  }

  public async answerQuestion(event: { questionId: number; answer: string }): Promise<void> {
    const card = this.task();
    if (!card) return;
    await this.store.answerQuestion(card.id, event.questionId, event.answer);
  }

  public async link(): Promise<void> {
    const card = this.task();
    const targetId = this.linkTargetId();
    if (!card || !targetId) return;
    await this.store.linkTasks(card.id, targetId, this.linkRelation());
    this.linkTargetId.set('');
  }

  public async unlink(linkedTaskId: string): Promise<void> {
    const card = this.task();
    if (!card) return;
    await this.store.unlinkTasks(card.id, linkedTaskId);
  }

  public openTask(id: string): void {
    void this.store.openCard(id);
  }

  // ------------------------------------------------- картинки и вложения

  /** Вставка из буфера обмена: картинки приходят как файлы (Ctrl+V). */
  @HostListener('window:paste', ['$event'])
  public onWindowPaste(event: ClipboardEvent): void {
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const files: File[] = [];
    for (const item of Array.from(clipboard.items ?? [])) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) files.push(...Array.from(clipboard.files ?? []));
    if (files.length > 0) void this.processImageFiles(files);
  }

  public onDragOverFiles(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFiles.set(true);
  }

  public onDragLeaveFiles(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFiles.set(false);
  }

  public onDropFiles(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFiles.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) void this.processImageFiles(Array.from(files));
  }

  public onImageInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) void this.processImageFiles(Array.from(input.files));
    input.value = '';
  }

  /** Читает изображения и загружает их на сервер (/api/images). */
  private async processImageFiles(files: readonly File[]): Promise<void> {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl) continue;
      const url = await this.store.uploadImage(dataUrl);
      if (url) this.images.update((current) => [...current, url]);
    }
  }

  public removeImage(index: number, event?: Event): void {
    event?.stopPropagation();
    this.images.update((current) => current.filter((_, position) => position !== index));
  }

  public onAttachmentInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length > 0) void this.processAttachmentFiles(Array.from(files));
    input.value = '';
  }

  /** Читает .md/.txt/.json и прикрепляет к карточке (в режиме создания — после сохранения). */
  private async processAttachmentFiles(files: readonly File[]): Promise<void> {
    const card = this.task();
    for (const file of files) {
      const text = await readFileAsText(file);
      if (text === null) continue;
      if (!card) {
        // Карточки ещё нет: складываем в очередь до сохранения.
        this.pendingAttachments.update((current) => [...current, { name: file.name, content: text }]);
        continue;
      }
      await this.store.attachFile(card.id, file.name, text);
    }
    if (card) await this.store.reloadOpenCard();
  }

  private readonly pendingAttachments = signal<{ name: string; content: string }[]>([]);

  public openAttachmentPreview(attachment: TaskAttachment): void {
    this.preview.set({ name: attachment.name, content: attachment.content });
  }

  public closePreview(): void {
    this.preview.set(null);
  }

  /** Крестик PrimeNG-диалога: visible=false приходит через visibleChange. */
  public onPreviewVisibleChange(open: boolean): void {
    if (!open) this.closePreview();
  }

  public async deleteAttachment(attachment: TaskAttachment): Promise<void> {
    const card = this.task();
    if (!card) return;
    await this.store.deleteAttachment(card.id, attachment.id);
  }

  public close(): void {
    this.closed.emit();
  }

  // ------------------------------------------------- сайдбар: размер и клавиши

  /** Тянем левую границу панели мышью (как в прежнем UI), ширина запоминается. */
  public onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = this.sidebarWidth();
    this.isResizing.set(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';

    const onMouseMove = (moveEvent: MouseEvent): void => {
      const deltaX = startX - moveEvent.clientX;
      const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 60);
      this.sidebarWidth.set(Math.min(maxWidth, Math.max(SIDEBAR_MIN_WIDTH, startWidth + deltaX)));
      this.isExpanded.set(false);
    };

    const onMouseUp = (): void => {
      this.isResizing.set(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth()));
      } catch {
        // приватный режим браузера — ширина просто не запомнится
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  /** Развернуть панель почти на весь экран / вернуть прежнюю ширину. */
  public toggleExpand(): void {
    if (this.isExpanded()) {
      this.isExpanded.set(false);
      this.sidebarWidth.set(this.widthBeforeExpand || SIDEBAR_DEFAULT_WIDTH);
      return;
    }
    this.widthBeforeExpand = this.sidebarWidth();
    this.isExpanded.set(true);
    this.sidebarWidth.set(Math.max(600, window.innerWidth - 60));
  }

  @HostListener('document:keydown.escape')
  public onEscapeKey(): void {
    this.close();
  }

  @HostListener('document:keydown', ['$event'])
  public onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  private syncFrom(card: TaskCard): void {
    const sameCard = this.lastSyncedTaskId() === card.id;
    this.lastSyncedTaskId.set(card.id);
    if (sameCard) return;

    this.title.set(card.title);
    this.description.set(card.description);
    this.type.set(card.type);
    this.status.set(card.status);
    this.requiresManualTest.set(card.requiresManualTest);
    this.tags.set(card.tags.map((tag) => tag.name));
    this.images.set(card.images.map((image) => image.url));
    this.attachments.set(card.attachments);
    this.commentDraft.set('');
    this.tab.set(card.openQuestionsCount > 0 ? 'questions' : 'overview');
  }

  public resetAfterCreate(): void {
    this.title.set('');
    this.description.set('');
    this.tags.set([]);
    this.type.set(this.createType());
    this.status.set(this.createStatus());
    this.requiresManualTest.set(false);
    this.lastSyncedTaskId.set(null);
  }
}

/** Читает файл как data-URL (для загрузки на сервер). */
function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Читает текстовый файл (.md, .txt, .json). */
function readFileAsText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}
