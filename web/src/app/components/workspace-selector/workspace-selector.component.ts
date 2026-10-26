import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmationService } from 'primeng/api';
import { ConfirmPopupModule } from 'primeng/confirmpopup';
import { TooltipModule } from 'primeng/tooltip';
import { WorkspaceService } from '../../services/workspace.service';

/** Переключатель пространств задач — p-select + кнопки создания/удаления. */
@Component({
  selector: 'sat-workspace-selector',
  providers: [ConfirmationService],
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, ButtonModule, InputTextModule, ConfirmPopupModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="workspace-selector">
      <p-select
        class="workspace-select"
        [options]="ws.options()"
        optionLabel="label"
        optionValue="value"
        [ngModel]="ws.current()"
        (ngModelChange)="onSwitch($event)"
        [showClear]="false"
        pTooltip="Пространство задач"
        tooltipPosition="bottom"
      ></p-select>

      <p-button
        icon="pi pi-plus"
        severity="secondary"
        [text]="true"
        [rounded]="true"
        size="small"
        pTooltip="Новое пространство"
        ariaLabel="Новое пространство"
        tooltipPosition="bottom"
        (onClick)="onShowCreate()"
      ></p-button>

      <p-button
        icon="pi pi-trash"
        severity="secondary"
        [text]="true"
        [rounded]="true"
        size="small"
        [disabled]="!canDelete()"
        pTooltip="Удалить пространство"
        tooltipPosition="bottom"
        (onClick)="onConfirmDelete()"
      ></p-button>
    </div>

    <!-- Диалог создания -->
    @if (showCreate()) {
      <div class="ws-create-overlay" (click)="showCreate.set(false)">
        <div class="ws-create-dialog" role="dialog" aria-modal="true" aria-labelledby="ws-create-title" (click)="$event.stopPropagation()">
          <h3 id="ws-create-title">Новое пространство</h3>
          <p class="ws-create-hint">Имя: 1-50 символов, латиница, цифры, дефис</p>
          <label class="ws-create-label">
            <span>Имя</span>
            <input pInputText [ngModel]="newName()" (ngModelChange)="newName.set($event)" placeholder="my-project" />
          </label>
          <label class="ws-create-label">
            <span>Отображаемое имя (опционально)</span>
            <input pInputText [ngModel]="newLabel()" (ngModelChange)="newLabel.set($event)" placeholder="My Project" />
          </label>
          <div class="ws-create-actions">
            <button type="button" pButton label="Отмена" severity="secondary" [text]="true" (click)="showCreate.set(false)"></button>
            <button type="button" pButton label="Создать" icon="pi pi-check" [loading]="creating()" (click)="onCreate()"></button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .workspace-selector {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .workspace-select {
      min-width: 140px;
      max-width: 200px;
    }

    .ws-create-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .ws-create-dialog {
      background: var(--p-dialog-background, var(--sat-surface));
      color: var(--p-dialog-color, var(--sat-text));
      border: 1px solid var(--p-dialog-border-color, var(--sat-border));
      border-radius: 0.5rem;
      padding: 1.5rem;
      box-sizing: border-box;
      width: min(400px, calc(100vw - 2rem));
      max-height: calc(100dvh - 2rem);
      overflow-y: auto;
    }

    .ws-create-dialog h3 {
      margin: 0 0 0.5rem;
      font-size: 1.1rem;
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

  public readonly showCreate = signal(false);
  public readonly creating = signal(false);
  public readonly newName = signal('');
  public readonly newLabel = signal('');

  /** Нельзя удалить "default" — его создаём автоматически. */
  public readonly canDelete = () => this.ws.current() !== 'default';

  public ngOnInit(): void {
    void this.ws.load();
  }

  public onSwitch(name: string): void {
    if (name === this.ws.current()) return;
    void this.ws.activate(name);
  }

  public onShowCreate(): void {
    this.newName.set('');
    this.newLabel.set('');
    this.showCreate.set(true);
  }

  public async onCreate(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    try {
      await this.ws.create(name, this.newLabel().trim() || undefined);
      this.showCreate.set(false);
    } finally {
      this.creating.set(false);
    }
  }

  public onConfirmDelete(): void {
    const current = this.ws.current();
    if (current === 'default') return;
    this.confirmationService.confirm({
      message: `Удалить пространство "${current}"? Все задачи в нём будут потеряны.`,
      header: 'Подтверждение',
      icon: 'pi pi-exclamation-triangle',
      acceptIcon: 'pi pi-trash',
      rejectIcon: 'pi pi-times',
      accept: () => void this.ws.remove(current),
    });
  }
}
