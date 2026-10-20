import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { TrackerStore } from '../../services/tracker-store.service';
import { formatBytes, formatDateTime } from '../../shared/format';

/**
 * Резервное копирование: PrimeNG-диалог со списком снимков базы.
 * Снимки делает сервер через SQLite `VACUUM INTO`, поэтому копия целостная.
 */
@Component({
  selector: 'sat-backup-panel',
  standalone: true,
  imports: [CommonModule, ButtonModule, DialogModule, MessageModule, TagModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './backup-panel.component.html',
  styleUrl: './backup-panel.component.scss',
})
export class BackupPanelComponent {
  public readonly store = inject(TrackerStore);
  public readonly closed = output<void>();

  /** Открытость PrimeNG-диалога (крестик закрывает через visibleChange). */
  public readonly isOpen = signal(true);
  public readonly busy = signal(false);
  public readonly message = signal<string | null>(null);

  public constructor() {
    void this.store.loadBackups();
  }

  public async createBackup(): Promise<void> {
    this.busy.set(true);
    const backup = await this.store.createBackup();
    this.busy.set(false);
    this.message.set(backup ? `Создан бэкап ${backup.name} (${formatBytes(backup.size)})` : 'Не удалось создать бэкап');
  }

  public async remove(name: string): Promise<void> {
    this.busy.set(true);
    await this.store.deleteBackup(name);
    this.busy.set(false);
    this.message.set(`Бэкап ${name} удалён`);
  }

  public close(): void {
    this.isOpen.set(false);
    this.closed.emit();
  }

  public readonly formatBytes = formatBytes;
  public readonly formatDateTime = formatDateTime;
}
