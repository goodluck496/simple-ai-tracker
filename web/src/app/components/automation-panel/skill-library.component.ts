import { ChangeDetectorRef, Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import type { AutomationSettings } from '../../../../../shared/automation/contracts';
import { SKILL_LIMITS, type LibrarySkill, type SkillSummary } from '../../../../../shared/automation/skills';
import { PickListModule } from 'primeng/picklist';
import { importSkillFile, skillFiles, type SkillFile } from './skill-import';

@Component({
  selector: 'sat-skill-library', standalone: true,
  imports: [FormsModule, NgTemplateOutlet, ButtonModule, CheckboxModule, DialogModule, InputTextModule, PickListModule, TextareaModule],
  template: `
    <section aria-label="Навыки проекта">
      <header><h4>Навыки проекта</h4><div><p-button label="Каталоги и импорт" severity="secondary" size="small" (onClick)="startImport()" />
        <p-button label="Создать навык" icon="pi pi-plus" severity="secondary" size="small" (onClick)="create()" /></div></header>
      <p>Отметьте навыки проекта. Назначить их ролям можно в разделе «Команда агентов».</p>
      <input pInputText [ngModel]="query" (ngModelChange)="search($event)" aria-label="Поиск по навыкам" placeholder="Найти по названию или условию применения" />
      @if (error && !editing) { <p role="alert">{{ error }} <button pButton type="button" [text]="true" (click)="load()">Обновить</button></p> }
      @for (skill of matches.slice(0,limit); track skill.id) {
        <article>
          <div class="skill-row">
            <p-checkbox [binary]="true" [inputId]="'bind-' + skill.id" [ngModel]="!!binding(skill.id)" (ngModelChange)="toggle(skill.id, $event)" />
            <div><label [for]="'bind-' + skill.id">{{ skill.name }}</label><small>{{ skill.description }}</small></div>
            <p-button label="Прочитать" severity="secondary" [text]="true" size="small" icon="pi pi-book" [ariaLabel]="'Прочитать ' + skill.name" (onClick)="readSaved(skill)" />
            <p-button severity="secondary" [text]="true" size="small" icon="pi pi-pencil" [ariaLabel]="'Редактировать ' + skill.name" (onClick)="edit(skill)" />
          </div>
        </article>
      } @empty { @if (query) { <p>Навыков по этому запросу нет.</p> } }
      @if (matches.length > limit) { <p-button label="Показать ещё" [text]="true" (onClick)="limit=limit+40" /> }
    </section>
    <p-dialog [header]="readerOpen ? (readingSkill?.name || readerTitle) : 'Импорт навыка'"
      [visible]="importing || readerOpen" (visibleChange)="closeLibrary()" [modal]="true" appendTo="body"
      [closable]="!loading" [closeOnEscape]="!loading" [style]="importDialogSize" [contentStyle]="dialogContent">
      <div class="editor" [hidden]="readerOpen">
        <div class="collections">
          @for (bank of collections; track bank.repo) {
            <p-button [label]="bank.label" severity="secondary" size="small" [disabled]="loading" (onClick)="chooseCollection(bank)" />
          }
        </div>
        <a href="https://skills.sh/" target="_blank" rel="noopener noreferrer">Найти другие коллекции на skills.sh</a>
        <label>Репозиторий GitHub или URL файла Markdown<input pInputText [disabled]="loading" [(ngModel)]="source" (ngModelChange)="clearCatalog()" /></label>
        @if (loading) { <p role="status">Загрузка из каталога…</p> }
        @if (catalogFiles.length || pendingFiles.length) {
          <p-picklist #picker [source]="availableFiles" [target]="pendingFiles" filterBy="path"
            sourceHeader="Файлы каталога" targetHeader="К импорту" scrollHeight="14rem" breakpoint="850px"
            [showSourceControls]="false" [showTargetControls]="false" [disabled]="loading"
            [responsive]="true" rightButtonAriaLabel="Добавить выбранные к импорту"
            allRightButtonAriaLabel="Добавить все из списка к импорту"
            leftButtonAriaLabel="Убрать выбранные из импорта" allLeftButtonAriaLabel="Очистить список импорта"
            sourceFilterPlaceholder="Найти файл" targetFilterPlaceholder="Найти выбранный файл"
            ariaSourceFilterLabel="Поиск файлов каталога" ariaTargetFilterLabel="Поиск выбранных файлов"
            (onMoveToTarget)="changeQueue(picker.target)" (onMoveAllToTarget)="changeQueue(picker.target)"
            (onMoveToSource)="changeQueue(picker.target)" (onMoveAllToSource)="changeQueue(picker.target)">
            <ng-template #item let-file>
              <div class="skill-file-row">
                <span>{{ file.path }}</span>
                <button pButton type="button" severity="secondary" [text]="true" size="small" icon="pi pi-book"
                  label="Прочитать" [attr.aria-label]="'Прочитать ' + file.path" [disabled]="loading"
                  (mousedown)="$event.stopPropagation()" (touchstart)="$event.stopPropagation()"
                  (keydown)="$event.stopPropagation()" (click)="$event.stopPropagation(); readFile(file)"></button>
              </div>
            </ng-template>
          </p-picklist>
        }
        @if (error) { <p role="alert">{{ error }}</p> }
      </div>
      @if (readerOpen) { <ng-container *ngTemplateOutlet="reader" /> }
      <ng-template #footer>
        <div class="editor-footer">
          @if (readerOpen) {
            <p-button [label]="importing ? 'Вернуться к списку' : 'Закрыть'" severity="secondary" [text]="true" (onClick)="readerOpen=false" />
            @if (readingSkill && !readingSkill.id) {
              <p-button label="Подготовить импорт" (onClick)="beginImportEdit(readingSkill)" />
            }
          } @else {
          <p-button label="Отмена" severity="secondary" [text]="true" [disabled]="loading" (onClick)="importing=false" />
          <p-button label="Загрузить по ссылке" severity="secondary" [disabled]="loading || !source.trim()" (onClick)="discover()" />
          <p-button label="Открыть следующий на импорт" [disabled]="loading || !pendingFiles.length" (onClick)="openNextImport()" />
          }
        </div>
      </ng-template>
    </p-dialog>
    <ng-template #reader>
      @if (readingSkill; as skill) {
        <div class="editor">
          @if (skill.sourceUrl) { <a [href]="skill.sourceUrl" target="_blank" rel="noopener noreferrer">Источник инструкции</a> }
          <p>{{ skill.description }}</p>
          <pre class="skill-text" tabindex="0">{{ skill.content }}</pre>
        </div>
      } @else if (readerError) {
        <p role="alert">{{ readerError }}</p>
      } @else {
        <p role="status">Загрузка инструкции…</p>
      }
    </ng-template>
    <p-dialog [header]="draft.id ? 'Изменить общий навык' : 'Новый общий навык'" [(visible)]="editing" [modal]="true" appendTo="body"
      [closable]="!saving" [closeOnEscape]="!saving" [style]="dialogSize" [contentStyle]="dialogContent" (onHide)="finishEditor()">
      <div class="editor">
        @if (draft.sourceUrl) { <a [href]="draft.sourceUrl" target="_blank" rel="noopener noreferrer">Источник инструкции</a> }
        <label>Название<input pInputText [(ngModel)]="draft.name" [maxlength]="limits.name" /></label>
        <label>Когда применять<textarea pTextarea rows="3" [maxlength]="limits.description" [(ngModel)]="draft.description"></textarea></label>
        <label>Инструкция<textarea pTextarea rows="12" [maxlength]="limits.content" [(ngModel)]="draft.content"></textarea></label>
        <small>{{ draft.content.length }} / {{ limits.content }} символов инструкции</small>
        @if (error) { <p role="alert">{{ error }}</p> }
      </div>
      <ng-template #footer>
        <div class="editor-footer">
          <p-button label="Отмена" severity="secondary" [text]="true" [disabled]="saving" (onClick)="editing=false" />
          <p-button label="Сохранить в библиотеку" [loading]="saving" [disabled]="saving || !draft.name.trim() || !draft.description.trim() || !draft.content.trim()" (onClick)="save()" />
        </div>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block }
    section, .editor {display:grid; gap:.75rem}
    header, .skill-row {display:flex; align-items:center; gap:.7rem}
    header {justify-content:space-between; flex-wrap:wrap}
    .collections {display:flex; gap:.4rem; flex-wrap:wrap}
    h4,p {margin:0}
    article {display:grid; gap:.5rem; padding:.6rem 0; border-top:1px solid var(--p-content-border-color)}
    .skill-row div {flex:1; min-width:0; overflow-wrap:anywhere}
    .skill-file-row {display:flex; align-items:center; gap:.45rem; width:100%; min-width:0}
    .skill-file-row span {flex:1; min-width:0; overflow-wrap:anywhere}
    .skill-file-row button {flex-shrink:0}
    .skill-text {margin:0; white-space:pre-wrap; overflow-wrap:anywhere}
    small,.editor label {display:block}
    small,section>p {color:var(--p-text-muted-color)}
    .skill-row small {display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden}
    .editor { grid-template-columns:minmax(0, 1fr); overflow-wrap:anywhere }
    .editor[hidden] { display:none }
    .editor label {display:grid; grid-template-columns:minmax(0, 1fr); gap:.35rem}
    .editor-footer {display:flex; justify-content:flex-end; flex-wrap:wrap; gap:.5rem}
    input,textarea {width:100%; min-width:0; box-sizing:border-box}
    textarea {resize:vertical; max-height:55dvh}
    [role=alert] {color:var(--p-red-500)}
  `]
})
export class SkillLibraryComponent implements OnInit {
  readonly limits = SKILL_LIMITS;
  readonly dialogSize = { width: 'min(56rem, 96vw)', height: 'min(52rem, 90dvh)' };
  readonly importDialogSize = { ...this.dialogSize, width: 'min(72rem, 96vw)' };
  readonly dialogContent = { overflowY: 'auto', overflowX: 'hidden', flex: '1 1 auto' };
  readonly collections = [
    {label:'Superpowers · разработка и тесты',repo:'obra/superpowers'},
    {label:'Anthropic · дизайн и инструменты',repo:'anthropics/skills'},
    {label:'Vercel · ревью интерфейса',repo:'vercel-labs/agent-skills'},
    { label: 'Nx', repo: 'nrwl/nx-ai-agents-config/tree/main/generated/.agents/skills' },
    { label: 'NestJS', repo: 'nestjs/agent-skills' },
    { label: 'Angular', repo: 'angular/skills' },
  ];
  @Input({required:true}) settings!: AutomationSettings;
  private readonly http = inject(HttpClient);
  private readonly changes = inject(ChangeDetectorRef);
  @Output() catalogChange = new EventEmitter<SkillSummary[]>();
  query = '';
  limit = 40;
  matches: SkillSummary[] = [];
  search(query: string): void {
    this.query = query;
    this.limit = 40;
    const term = this.query.trim().toLocaleLowerCase();
    this.matches = term ? this.skills.filter(s => (s.name + ' ' + s.description).toLocaleLowerCase().includes(term)) : this.skills;
  }
  skills: SkillSummary[] = [];
  draft: LibrarySkill = {id:'', version:0, name:'', description:'', content:''};
  importing = false;
  loading = false;
  source = '';
  catalogFiles: SkillFile[] = [];
  availableFiles: SkillFile[] = [];
  pendingFiles: SkillFile[] = [];
  private readonly importedUrls = new Set<string>();
  private editingFromImport = false;
  readerOpen = false;
  readerTitle = '';
  readerError = '';
  private readerRequest = 0;
  readingSkill: LibrarySkill | null = null;
  editing = false;
  saving = false;
  error = '';
  ngOnInit(): void { void this.load(); }
  closeLibrary(): void {
    this.readerOpen = false;
    this.importing = false;
  }
  startImport(): void {
    this.readingSkill = null;
    this.source = '';
    this.pendingFiles = [];
    this.importedUrls.clear();
    this.clearCatalog();
    this.importing = true;
  }
  clearCatalog(): void {
    this.catalogFiles = [];
    this.availableFiles = [];
    this.error = '';
  }
  chooseCollection(bank: {repo:string}): void {
    this.source = 'https://github.com/' + bank.repo;
    void this.discover();
  }
  async discover(): Promise<void> {
    if (this.loading) return;
    this.clearCatalog();
    this.loading = true;
    try {
      this.catalogFiles = await skillFiles(this.source);
      this.changeQueue(this.pendingFiles);
      if (!this.catalogFiles.length) this.error = 'В этом репозитории не найден SKILL.md.';
    } catch (e) { this.error = this.importError(e); }
    finally { this.loading = false; }
  }
  changeQueue(target: SkillFile[] | undefined): void {
    this.pendingFiles = [...(target ?? [])];
    const queued = new Set(this.pendingFiles.map(file => file.url));
    this.availableFiles = this.catalogFiles.filter(file => !queued.has(file.url) && !this.importedUrls.has(file.url));
  }
  readFile(file: SkillFile): Promise<void> {
    return this.preview(file.path, () => importSkillFile(file));
  }
  async openNextImport(): Promise<void> {
    const file = this.pendingFiles[0];
    if (!file) return;
    const skill = this.readingSkill?.sourceUrl === file.url && !this.readingSkill.id
      ? this.readingSkill : await this.loadFile(file);
    if (skill) this.beginImportEdit(skill);
  }
  private async loadFile(file: SkillFile): Promise<LibrarySkill | undefined> {
    if (this.loading) return;
    this.loading = true; this.error = '';
    try {
      return await importSkillFile(file);
    } catch (e) { this.error = this.importError(e); }
    finally { this.loading = false; }
  }
  beginImportEdit(skill: LibrarySkill): void {
    this.draft = { ...skill };
    this.readerOpen = false;
    this.importing = false;
    this.editingFromImport = true;
    this.editing = true;
  }
  finishEditor(): void {
    if (this.editingFromImport) {
      this.editingFromImport = false;
      this.error = '';
      this.importing = true;
    }
  }
  private importError(e: unknown): string {
    return e instanceof TypeError ? 'Проверьте URL и доступность источника для браузера (CORS).' : String(e instanceof Error ? e.message : e);
  }
  async load(): Promise<void> {
    try {
      this.skills = await firstValueFrom(this.http.get<SkillSummary[]>('/api/automation/skills'));
      this.search(this.query);
      this.catalogChange.emit(this.skills);
      this.error = '';
    }
    catch { this.error = 'Не удалось загрузить общую библиотеку.'; }
  }
  binding(id: string) { return this.settings.skillBindings?.find(item => item.skillId === id); }
  toggle(id: string, enabled: boolean): void {
    const others = (this.settings.skillBindings ?? []).filter(item => item.skillId !== id);
    this.settings.skillBindings = enabled ? [...others, { skillId:id, roles:[] }] : others;
  }
  create(): void {
    this.draft = {id:'', version:0, name:'', description:'', content:''}; this.error = ''; this.editing = true;
  }
  async edit(skill: SkillSummary): Promise<void> {
    try {
      this.draft = await this.loadSavedSkill(skill);
      this.error = ''; this.editing = true;
    } catch { this.error = 'Не удалось открыть инструкцию.'; }
  }
  readSaved(skill: SkillSummary): Promise<void> {
    return this.preview(skill.name, () => this.loadSavedSkill(skill));
  }
  private async preview(title: string, load: () => Promise<LibrarySkill>): Promise<void> {
    const request = ++this.readerRequest;
    this.readerTitle = title;
    this.readingSkill = null;
    this.readerError = '';
    this.readerOpen = true;
    try {
      const skill = await load();
      if (request === this.readerRequest && this.readerOpen) this.readingSkill = skill;
    } catch (error) {
      if (request === this.readerRequest) this.readerError = 'Не удалось открыть инструкцию. ' + this.importError(error);
    } finally {
      this.changes.markForCheck();
    }
  }
  private loadSavedSkill(skill: SkillSummary): Promise<LibrarySkill> {
    return firstValueFrom(this.http.get<LibrarySkill>(`/api/automation/skills/${skill.id}/${skill.version}`));
  }
  async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      const url = '/api/automation/skills';
      const saved = await firstValueFrom(this.draft.id ? this.http.patch<LibrarySkill>(url + '/' + this.draft.id, this.draft) : this.http.post<LibrarySkill>(url, this.draft));
      const { content, ...summary } = saved;
      this.skills = this.draft.id ? this.skills.map(s => s.id === saved.id ? summary : s) : [...this.skills, summary];
      this.search(this.query);
      this.catalogChange.emit(this.skills);
      if (this.editingFromImport && saved.sourceUrl) {
        this.importedUrls.add(saved.sourceUrl);
        this.changeQueue(this.pendingFiles.filter(file => file.url !== saved.sourceUrl));
        this.editingFromImport = this.pendingFiles.length > 0;
      }
      this.error = ''; this.editing = false;
    } catch (error) {
      this.error = (error as {error?:{error?:{message?:string}}}).error?.error?.message ?? 'Не удалось сохранить навык.';
      if ((error as {status?:number}).status === 409) {
        const message = this.error;
        await this.load();
        this.error = message;
      }
    } finally { this.saving = false; }
  }
}
