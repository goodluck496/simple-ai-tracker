import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { ChipModule } from 'primeng/chip';
import { InputTextModule } from 'primeng/inputtext';
import { PopoverModule } from 'primeng/popover';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import type { SearchScope, SearchScopeOption, TaskType } from '../../models/tracker.models';
import { SEARCH_SCOPE_OPTIONS } from '../../models/tracker.models';
import { TrackerStore } from '../../services/tracker-store.service';

interface FilterOption<T> {
  readonly label: string;
  readonly value: T | null;
}

/**
 * Панель поиска и фильтров в шапке: PrimeNG popover с чекбоксами полей поиска,
 * чипы выбранных полей и PrimeNG-селекты фильтров.
 */
@Component({
  selector: 'sat-toolbar',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CheckboxModule,
    ChipModule,
    InputTextModule,
    PopoverModule,
    SelectModule,
    TooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.scss',
})
export class ToolbarComponent {
  public readonly store = inject(TrackerStore);

  public readonly createRequested = output<TaskType>();
  public readonly tagsRequested = output<void>();
  public readonly backupRequested = output<void>();

  public readonly scopeOptions: SearchScopeOption[] = [...SEARCH_SCOPE_OPTIONS];
  public readonly scopeMenuOpen = signal(false);

  public readonly typeOptions: FilterOption<TaskType>[] = [
    { label: 'Фичи', value: 'feature' },
    { label: 'Задачи', value: 'task' },
    { label: 'Баги', value: 'bug' },
  ];

  public readonly featureOptions = computed<FilterOption<string>[]>(() =>
    this.store.features().map((feature) => ({ label: `${feature.id} — ${feature.title}`, value: feature.id })),
  );

  public readonly featureFilter = computed(() => this.store.featureFilter());

  public onFeatureChange(value: string | null): void {
    if (value) this.store.toggleFeatureFilter(value);
    else if (this.store.featureFilter()) this.store.toggleFeatureFilter(this.store.featureFilter()!);
  }

  public readonly tagOptions = computed<FilterOption<string>[]>(() =>
    this.store.tags().map((tag) => ({ label: `#${tag.name}`, value: tag.name })),
  );

  public readonly typeFilter = computed(() => this.store.typeFilter());
  public readonly tagFilter = computed(() => this.store.tagFilter());

  /** Подписи выбранных фильтров: селект обрезает длинный текст, полный — в тултипе. */
  public readonly typeFilterLabel = computed(
    () => this.typeOptions.find((option) => option.value === this.typeFilter())?.label ?? '',
  );
  public readonly tagFilterLabel = computed(
    () => this.tagOptions().find((option) => option.value === this.tagFilter())?.label ?? '',
  );
  public readonly featureFilterLabel = computed(
    () => this.featureOptions().find((option) => option.value === this.featureFilter())?.label ?? '',
  );

  public onQueryInput(value: string): void {
    this.store.setQuery(value);
  }

  public clearQuery(): void {
    this.store.setQuery('');
  }

  public isScopeActive(scope: SearchScope): boolean {
    return this.store.isScopeActive(scope);
  }

  public toggleScope(scope: SearchScope): void {
    this.store.toggleSearchScope(scope);
  }

  public selectAllScopes(): void {
    this.store.setSearchScopes(SEARCH_SCOPE_OPTIONS.map((option) => option.key));
  }

  public selectOnlyTitle(): void {
    this.store.setSearchScopes(['title']);
  }

  public onTypeChange(value: TaskType | null): void {
    this.store.setTypeFilter(value);
  }

  public onTagChange(value: string | null): void {
    this.store.setTagFilter(value);
  }

  public resetFilters(): void {
    this.store.clearFilters();
  }

  public refresh(): void {
    void this.store.refresh();
  }
}
