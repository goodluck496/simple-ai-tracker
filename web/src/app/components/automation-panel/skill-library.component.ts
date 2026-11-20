import { Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import type { AutomationSettings } from '../../../../../shared/automation/contracts';
import type { LibrarySkill, SkillSummary } from '../../../../../shared/automation/skills';
import { SelectModule } from 'primeng/select';
import { importSkillFile, skillFiles, type SkillFile } from './skill-import';

@Component({
  selector: 'sat-skill-library', standalone: true,
  imports: [FormsModule, ButtonModule, CheckboxModule, DialogModule, InputTextModule, SelectModule, TextareaModule],
  template: `
    <section aria-label="Навыки проекта">
      <header><h4>Навыки проекта</h4><div><p-button label="Каталоги и импорт" severity="secondary" size="small" (onClick)="startImport()" />
        <p-button label="Создать навык" icon="pi pi-plus" severity="secondary" size="small" (onClick)="create()" /></div></header>
      <p>Отметьте навыки проекта. Назначить их ролям можно в разделе «Команда и этапы».</p>
      <input pInputText [ngModel]="query" (ngModelChange)="search($event)" aria-label="Поиск по навыкам" placeholder="Найти по названию или условию применения" />
      @if (error && !editing) { <p role="alert">{{ error }} <button pButton type="button" [text]="true" (click)="load()">Обновить</button></p> }
      @for (skill of matches.slice(0,limit); track skill.id) {
        <article>
          <div class="skill-row">
            <p-checkbox [binary]="true" [inputId]="'bind-' + skill.id" [ngModel]="!!binding(skill.id)" (ngModelChange)="toggle(skill.id, $event)" />
            <div><label [for]="'bind-' + skill.id">{{ skill.name }}</label><small>{{ skill.description }}</small></div>
            <p-button severity="secondary" [text]="true" size="small" icon="pi pi-pencil" [ariaLabel]="'Редактировать ' + skill.name" (onClick)="edit(skill)" />
          </div>
        </article>
      } @empty { @if (query) { <p>Навыков по этому запросу нет.</p> } }
      @if (matches.length > limit) { <p-button label="Показать ещё" [text]="true" (onClick)="limit=limit+40" /> }
    </section>
    <p-dialog header="Импорт навыка" [(visible)]="importing" [modal]="true" appendTo="body" [closable]="!loading" [closeOnEscape]="!loading" [style]="{width:'36rem',maxWidth:'95vw'}">
      <div class="editor">
        <div class="collections">
          @for (bank of collections; track bank.repo) {
            <p-button [label]="bank.label" severity="secondary" size="small" [disabled]="loading" (onClick)="chooseCollection(bank)" />
          }
        </div>
        <a href="https://skills.sh/" target="_blank" rel="noopener noreferrer">Найти другие коллекции на skills.sh</a>
        <label>Репозиторий GitHub или URL файла Markdown<input pInputText [disabled]="loading" [(ngModel)]="source" (ngModelChange)="files=[]; selectedFile=null" /></label>
        <p>В библиотеку копируется текст инструкции. Файлы скриптов и шаблоны из репозитория требуют отдельной установки.</p>
        <p-button label="Загрузить по ссылке" [disabled]="loading || !source.trim()" (onClick)="discover()" />
        @if (files.length) {
          <p-select [options]="files" optionLabel="path" [filter]="true" filterBy="path" [(ngModel)]="selectedFile" ariaLabel="Файл навыка" appendTo="body" />
          <p-button label="Открыть инструкцию" [disabled]="loading || !selectedFile" (onClick)="preview()" />
        }
        @if (error) { <p role="alert">{{ error }}</p> }
      </div>
    </p-dialog>
    <p-dialog [header]="draft.id ? 'Изменить общий навык' : 'Новый общий навык'" [(visible)]="editing" [modal]="true" appendTo="body"
      [closable]="!saving" [closeOnEscape]="!saving" [style]="{width: '36rem', maxWidth: '95vw'}">
      <div class="editor">
        @if (draft.sourceUrl) { <a [href]="draft.sourceUrl" target="_blank" rel="noopener noreferrer">Источник инструкции</a> }
        <label>Название<input pInputText [(ngModel)]="draft.name" maxlength="100" /></label>
        <label>Когда применять<textarea pTextarea rows="2" maxlength="320" [(ngModel)]="draft.description"></textarea></label>
        <label>Инструкция<textarea pTextarea rows="8" maxlength="16000" [(ngModel)]="draft.content"></textarea></label>
        @if (error) { <p role="alert">{{ error }}</p> }
        <p-button label="Сохранить в библиотеку" [loading]="saving" [disabled]="saving || !draft.name.trim() || !draft.description.trim() || !draft.content.trim()" (onClick)="save()" />
      </div>
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
    small,.editor label {display:block}
    small,section>p {color:var(--p-text-muted-color)}
    .editor label {display:grid; gap:.35rem}
    input,textarea {width:100%}
    [role=alert] {color:var(--p-red-500)}
  `]
})
export class SkillLibraryComponent implements OnInit {
  readonly collections = [
    {label:'Superpowers · разработка и тесты',repo:'obra/superpowers',skill:'test-driven-development'},
    {label:'Anthropic · дизайн и инструменты',repo:'anthropics/skills',skill:'frontend-design'},
    {label:'Vercel · ревью интерфейса',repo:'vercel-labs/agent-skills',skill:'web-design-guidelines'},
  ];
  @Input({required:true}) settings!: AutomationSettings;
  private readonly http = inject(HttpClient);
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
  files: SkillFile[] = [];
  selectedFile: SkillFile | null = null;
  editing = false;
  saving = false;
  error = '';
  ngOnInit(): void { void this.load(); }
  startImport(): void {
    this.source = ''; this.files = []; this.selectedFile = null; this.error = ''; this.importing = true;
  }
  chooseCollection(bank: {repo:string; skill:string}): void {
    this.source = 'https://github.com/' + bank.repo;
    void this.discover(bank.skill);
  }
  async discover(preferred?:string): Promise<void> {
    this.loading = true; this.error = ''; this.files = []; this.selectedFile = null;
    try {
      this.files = await skillFiles(this.source);
      this.selectedFile = this.files.find(file => preferred && file.path.endsWith('/' + preferred + '/SKILL.md')) ?? this.files[0] ?? null;
      if (!this.selectedFile) this.error = 'В этом репозитории не найден SKILL.md.';
    } catch (e) { this.error = this.importError(e); }
    finally { this.loading = false; }
  }
  async preview(): Promise<void> {
    if (!this.selectedFile) return;
    this.loading = true; this.error = '';
    try {
      this.draft = await importSkillFile(this.selectedFile); this.importing = false; this.editing = true;
    } catch (e) { this.error = this.importError(e); }
    finally { this.loading = false; }
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
      this.draft = await firstValueFrom(this.http.get<LibrarySkill>(`/api/automation/skills/${skill.id}/${skill.version}`));
      this.error = ''; this.editing = true;
    } catch { this.error = 'Не удалось открыть инструкцию.'; }
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
