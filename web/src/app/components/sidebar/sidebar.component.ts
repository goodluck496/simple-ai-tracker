import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DrawerModule } from 'primeng/drawer';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import type { TaskType } from '../../models/tracker.models';
import { TrackerStore } from '../../services/tracker-store.service';
import { WorkspaceSelectorComponent } from '../workspace-selector/workspace-selector.component';

interface FilterOption<T> {
  readonly label: string;
  readonly value: T | null;
}

@Component({
  selector: 'sat-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    DrawerModule,
    ButtonModule,
    TooltipModule,
    WorkspaceSelectorComponent,
    SelectModule,
    FormsModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
})
export class SidebarComponent {
  public readonly store = inject(TrackerStore);

  public readonly visible = model<boolean>(false);

  public readonly openQueue = output<string | null>();
  public readonly openAutomation = output<void>();
  public readonly openBatchAutomation = output<void>();
  public readonly showTags = output<boolean>();
  public readonly showBackups = output<boolean>();
  public readonly showInstructions = output<boolean>();

  public readonly typeOptions: FilterOption<TaskType>[] = [
    { label: 'Фичи', value: 'feature' },
    { label: 'Задачи', value: 'task' },
    { label: 'Баги', value: 'bug' },
  ];

  public readonly featureOptions = computed<FilterOption<string>[]>(() =>
    this.store.features().map((feature) => ({ label: `${feature.id} — ${feature.title}`, value: feature.id })),
  );

  public readonly typeFilter = computed(() => this.store.typeFilter());
  public readonly featureFilter = computed(() => this.store.featureFilter());

  public onTypeChange(value: TaskType | null): void {
    this.store.setTypeFilter(value);
  }

  public onFeatureChange(value: string | null): void {
    if (value) this.store.toggleFeatureFilter(value);
    else if (this.store.featureFilter()) this.store.toggleFeatureFilter(this.store.featureFilter()!);
  }

  public resetBoardFilters(): void {
    this.store.setTypeFilter(null);
    if (this.store.featureFilter()) {
      this.store.toggleFeatureFilter(this.store.featureFilter()!);
    }
  }

  public onOpenQueue(): void {
    this.visible.set(false);
    this.openQueue.emit(null);
  }

  public onOpenAutomation(): void {
    this.visible.set(false);
    this.openAutomation.emit();
  }

  public onOpenBatchAutomation(): void {
    this.visible.set(false);
    this.openBatchAutomation.emit();
  }

  public onShowTags(): void {
    this.visible.set(false);
    this.showTags.emit(true);
  }

  public onShowBackups(): void {
    this.visible.set(false);
    this.showBackups.emit(true);
  }

  public onShowInstructions(): void {
    this.visible.set(false);
    this.showInstructions.emit(true);
  }
}
