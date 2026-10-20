import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ColorPickerModule } from 'primeng/colorpicker';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { TrackerStore } from '../../services/tracker-store.service';

/** Реестр тегов: PrimeNG-диалог, поля ввода, добавление/удаление и фильтр по тегу. */
@Component({
  selector: 'sat-tags-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    ColorPickerModule,
    DialogModule,
    InputTextModule,
    TagModule,
    TooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tags-panel.component.html',
  styleUrl: './tags-panel.component.scss',
})
export class TagsPanelComponent {
  public readonly store = inject(TrackerStore);
  public readonly closed = output<void>();

  /** Открытость PrimeNG-диалога (крестик закрывает через visibleChange). */
  public readonly isOpen = signal(true);
  public readonly name = signal('');
  public readonly color = signal('#4c8dff');
  public readonly sortedTags = computed(() =>
    [...this.store.tags()].sort((a, b) => (b.tasksCount ?? 0) - (a.tasksCount ?? 0) || a.name.localeCompare(b.name)),
  );

  public async add(): Promise<void> {
    const name = this.name().trim().toLowerCase();
    if (!name) return;
    await this.store.addTag(name, this.color());
    this.name.set('');
  }

  public async remove(name: string): Promise<void> {
    await this.store.deleteTag(name);
  }

  public filterBy(name: string): void {
    this.store.toggleTagFilter(name);
    this.close();
  }

  public close(): void {
    this.isOpen.set(false);
    this.closed.emit();
  }
}
