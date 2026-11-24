import { ChangeDetectionStrategy, Component, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmationService } from 'primeng/api';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { WORKSPACE_BACKGROUNDS, isWorkspaceBackground, type WorkspaceBackground } from '../../../../../shared/workspace-background';
import { WorkspaceService, type Workspace } from '../../services/workspace.service';

@Component({
  selector: 'sat-workspace-selector',
  providers: [ConfirmationService],
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, ConfirmDialogModule, TooltipModule, DialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="workspace-picker">
      <div class="workspace-picker-actions">
        <p-button label="Новое пространство" ariaLabel="Новое пространство" icon="pi pi-plus" size="small" (onClick)="onShowCreate()" />
      </div>
      @if (workspaceError()) { <p role="alert">{{ workspaceError() }}</p> }
      <div class="workspace-grid" aria-label="Список рабочих пространств">
        @for (workspace of ws.workspaces(); track workspace.name) {
          <article class="workspace-card" [attr.aria-label]="workspace.label"
            [attr.data-background]="backgroundFor(workspace)" [class.workspace-card--active]="workspace.name === ws.current()">
            <button pButton type="button" class="workspace-card-main"
              [attr.aria-label]="'Открыть пространство ' + workspace.label" [attr.aria-current]="workspace.name === ws.current() ? 'true' : null"
              [disabled]="!!switching()" (click)="onSwitch(workspace.name)">
              <span class="workspace-mark" aria-hidden="true"><i class="pi pi-briefcase"></i></span>
              <span class="workspace-title">{{ workspace.label }}</span>
              @if (workspace.name === ws.current()) { <span class="workspace-active"><i class="pi pi-check" aria-hidden="true"></i> Активно</span> }
            </button>
            <div class="workspace-card-actions">
              <button pButton type="button" size="small" severity="secondary" [text]="true" icon="pi pi-pencil"
                aria-label="Переименовать пространство" pTooltip="Название, префикс и фон" (click)="onShowRename(workspace)"></button>
              @if (workspace.name !== 'default') {
                <button pButton type="button" size="small" severity="secondary" [text]="true" icon="pi pi-trash"
                  aria-label="Удалить пространство" pTooltip="Удалить пространство" (click)="onConfirmDelete(workspace)"></button>
              }
            </div>
          </article>
        } @empty {
          @if (ws.loading()) { <p role="status">Загрузка пространств…</p> }
        }
      </div>
    </div>
    <p-confirmdialog appendTo="body" />

    <p-dialog header="Переименовать пространство" [visible]="showRename()" (visibleChange)="showRename.set($event)"
      [modal]="true" appendTo="body" [style]="{width: '26rem', maxWidth: 'calc(100vw - 2rem)'}" [closable]="!renaming()" [closeOnEscape]="!renaming()">
      <form (ngSubmit)="onRename()">
        <label class="ws-create-label">Название пространства
          <input pInputText name="workspaceLabel" [ngModel]="renameLabel()" (ngModelChange)="renameLabel.set($event)" maxlength="100" autofocus [disabled]="renaming()" />
        </label>
        <label class="ws-create-label">Префикс новых задач
          <input pInputText name="workspacePrefix" [ngModel]="renamePrefix()" (ngModelChange)="renamePrefix.set($event)" maxlength="20" [disabled]="renaming()" placeholder="MS" />
        </label>
        <p class="ws-create-hint">Например MS или SAT. Номера существующих задач сохранятся.</p>
        <fieldset class="background-picker">
          <legend>Фон карточки</legend>
          <div class="background-options">
            @for (option of backgrounds; track option.value) {
              <button pButton type="button" size="small" severity="secondary" [outlined]="true"
                [attr.aria-pressed]="renameBackground() === option.value" [disabled]="renaming()"
                (click)="renameBackground.set(option.value)">
                <span class="background-swatch" [attr.data-background]="option.value ?? 'slate'" aria-hidden="true"></span>{{ option.label }}
              </button>
            }
          </div>
        </fieldset>
        @if (renameError()) { <p role="alert">{{ renameError() }}</p> }
        <div class="ws-create-actions">
          <p-button label="Отмена" severity="secondary" [disabled]="renaming()" (onClick)="showRename.set(false)" />
          <p-button type="submit" label="Сохранить название" [loading]="renaming()" [disabled]="!renameLabel().trim() || !renamePrefix().trim() || renaming()" />
        </div>
      </form>
    </p-dialog>
    <p-dialog header="Новое пространство" [visible]="showCreate()" (visibleChange)="showCreate.set($event)"
      [modal]="true" appendTo="body" [style]="{width:'26rem',maxWidth:'96vw',maxHeight:'90dvh'}"
      [closable]="!creating()" [closeOnEscape]="!creating()">
      <form (ngSubmit)="onCreate()">
        <label class="ws-create-label">Системное имя
          <input pInputText name="workspaceName" [ngModel]="newName()" (ngModelChange)="newName.set($event)" placeholder="my-project" maxlength="50" />
        </label>
        <p class="ws-create-hint">Латиница, цифры, дефис или подчёркивание.</p>
        <label class="ws-create-label">Отображаемое имя
          <input pInputText name="workspaceLabel" [ngModel]="newLabel()" (ngModelChange)="newLabel.set($event)" placeholder="My Project" />
        </label>
        <label class="ws-create-label">Префикс новых задач
          <input pInputText name="workspacePrefix" [ngModel]="newPrefix()" (ngModelChange)="newPrefix.set($event)" maxlength="20" placeholder="SAT" />
        </label>
        @if (createError()) { <p role="alert">{{ createError() }}</p> }
        <div class="ws-create-actions">
          <p-button label="Отмена" severity="secondary" [disabled]="creating()" (onClick)="showCreate.set(false)" />
          <p-button type="submit" label="Создать" [loading]="creating()" [disabled]="!newName().trim() || creating()" />
        </div>
      </form>
    </p-dialog>
  `,
  styles: `
    .workspace-picker { display: grid; gap: 0.85rem; }
    .workspace-picker-actions { display: flex; justify-content: flex-end; }
    .workspace-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 12.5rem), 1fr));
      gap: 0.85rem;
    }
    [data-background='ocean'] { --card-tint: #0c4564; --card-light: #38bdf8; }
    [data-background='moss'] { --card-tint: #164c3c; --card-light: #4ade80; }
    [data-background='plum'] { --card-tint: #4c2862; --card-light: #c084fc; }
    [data-background='ember'] { --card-tint: #643c25; --card-light: #fb923c; }
    [data-background='slate'] { --card-tint: #34445e; --card-light: #94a3b8; }

    .workspace-card {
      position: relative;
      min-width: 0;
      border: 1px solid var(--p-content-border-color);
      border-radius: 0.9rem;
      background:
        radial-gradient(ellipse at 100% 0%, var(--card-tint), transparent 75%),
        linear-gradient(145deg, #1c2638, #101724 65%);
    }
    .workspace-card--active { border-color: var(--p-primary-color); }
    .workspace-card-main.p-button {
      display: flex;
      width: 100%;
      min-height: 9rem;
      flex-direction: column;
      align-items: flex-start;
      justify-content: flex-start;
      gap: 0.58rem;
      padding: 0.85rem;
      border: 0;
      border-radius: inherit;
      color: #f1f5f9;
      background: transparent;
      text-align: left;
    }
    .workspace-card-main.p-button:hover { background: rgb(255 255 255 / 0.07); color: #fff; }
    .workspace-mark {
      display: grid;
      place-items: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.65rem;
      background: color-mix(in srgb, var(--card-light) 16%, transparent);
      color: var(--card-light);
    }
    .workspace-title { overflow-wrap: anywhere; font-size: 1rem; font-weight: 650; }
    .workspace-active { font-size: 0.75rem; color: #b7f7de; }
    .workspace-card-actions { position: absolute; top: 0.5rem; right: 0.5rem; display: flex; gap: 0.15rem; }
    .background-picker { margin: 0; border: 0; padding: 0; color: var(--p-text-muted-color); font-size: 0.85rem; }
    .background-options { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.4rem; }
    .background-options button[aria-pressed='true'] { border-color: var(--p-primary-color); }
    .background-swatch {
      width: 1rem;
      height: 1rem;
      border-radius: 0.25rem;
      background: linear-gradient(135deg, var(--card-light), var(--card-tint));
    }

    .ws-create-hint {
      font-size: 0.75rem;
      color: var(--p-text-muted-color, #999);
      margin: 0 0 1rem;
    }

    .ws-create-label {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      margin-bottom: 0.75rem;
      font-size: 0.85rem;
      color: var(--p-text-muted-color, #999);
    }

    .ws-create-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1rem;
    }
  `,
})
export class WorkspaceSelectorComponent implements OnInit {
  public readonly ws = inject(WorkspaceService);
  private readonly confirmationService = inject(ConfirmationService);
  public readonly selected = output<void>();
  public readonly workspaceError = signal('');
  public readonly switching = signal<string | null>(null);
  public readonly backgrounds: { label: string; value: WorkspaceBackground | null }[] = [
    { label: 'Авто', value: null }, { label: 'Океан', value: 'ocean' }, { label: 'Мох', value: 'moss' },
    { label: 'Слива', value: 'plum' }, { label: 'Янтарь', value: 'ember' }, { label: 'Графит', value: 'slate' },
  ];

  public backgroundFor(workspace: Workspace): WorkspaceBackground {
    if (isWorkspaceBackground(workspace.background)) return workspace.background;
    let hash = 0;
    for (const char of workspace.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return WORKSPACE_BACKGROUNDS[hash % WORKSPACE_BACKGROUNDS.length];
  }

  public readonly showCreate = signal(false);
  public readonly creating = signal(false);
  public readonly newName = signal('');
  public readonly newLabel = signal('');
  public readonly newPrefix = signal('SAT');
  public readonly createError = signal('');
  public readonly showRename = signal(false);
  public readonly renaming = signal(false);
  public readonly renameLabel = signal('');
  public readonly renamePrefix = signal('');
  public readonly renameBackground = signal<WorkspaceBackground | null>(null);
  public readonly renameError = signal('');
  private renameTarget = '';

  public async onShowRename(workspace: Workspace): Promise<void> {
    this.renameTarget = workspace.name;
    this.renameLabel.set(workspace.label);
    this.renameBackground.set(workspace.background ?? null);
    this.renameError.set('');
    this.renamePrefix.set('');
    this.showRename.set(true);
    this.renaming.set(true);
    try { this.renamePrefix.set((await this.ws.prefix(this.renameTarget)).idPrefix); }
    catch { this.renameError.set('Не удалось загрузить префикс пространства. Закройте окно и повторите.'); }
    finally { this.renaming.set(false); }
  }
  public async onRename(): Promise<void> {
    if (this.renaming() || !this.renameLabel().trim() || !this.renamePrefix().trim()) return;
    this.renaming.set(true); this.renameError.set('');
    try { await this.ws.rename(this.renameTarget, this.renameLabel().trim(), this.renamePrefix().trim(), this.renameBackground()); this.showRename.set(false); }
    catch (error) {
      const response = error as { error?: { error?: { message?: string } } };
      this.renameError.set(response.error?.error?.message ?? 'Не удалось переименовать пространство. Попробуйте ещё раз.');
    } finally { this.renaming.set(false); }
  }

  public ngOnInit(): void {
    void this.ws.load().catch(() => this.workspaceError.set('Не удалось загрузить рабочие пространства.'));
  }

  public async onSwitch(name: string): Promise<void> {
    if (this.switching()) return;
    if (name === this.ws.current()) {
      this.selected.emit();
      return;
    }
    this.switching.set(name);
    this.workspaceError.set('');
    try { await this.ws.activate(name); }
    catch {
      this.workspaceError.set('Не удалось открыть рабочее пространство.');
      this.switching.set(null);
    }
  }

  public onShowCreate(): void {
    this.newName.set('');
    this.newLabel.set('');
    this.newPrefix.set('SAT');
    this.createError.set('');
    this.showCreate.set(true);
  }

  public async onCreate(): Promise<void> {
    const name = this.newName().trim();
    if (!name || this.creating()) return;
    this.creating.set(true);
    this.createError.set('');
    try {
      await this.ws.create(name, this.newLabel().trim() || undefined, this.newPrefix().trim());
      this.showCreate.set(false);
    } catch (error) {
      const response = error as { error?: { error?: { message?: string } } };
      this.createError.set(response.error?.error?.message ?? 'Не удалось создать пространство. Проверьте имя и префикс.');
    } finally {
      this.creating.set(false);
    }
  }

  public onConfirmDelete(workspace: Workspace): void {
    if (workspace.name === 'default') return;
    this.confirmationService.confirm({
      message: `Удалить пространство «${workspace.label}»? Все его задачи будут потеряны.`,
      header: 'Удалить пространство',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Удалить',
      rejectLabel: 'Отмена',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.workspaceError.set('');
        void this.ws.remove(workspace.name).catch(() => this.workspaceError.set('Не удалось удалить рабочее пространство.'));
      },
    });
  }
}
