export const COLUMN_SORT_OPTIONS = [
  { value: 'manual', label: 'Ручной порядок' },
  { value: 'created-desc', label: 'Созданы: сначала новые' },
  { value: 'created-asc', label: 'Созданы: сначала старые' },
  { value: 'updated-desc', label: 'Обновлены: сначала новые' },
  { value: 'updated-asc', label: 'Обновлены: сначала старые' },
] as const;
export type ColumnSort = typeof COLUMN_SORT_OPTIONS[number]['value'];
export interface SortableTask { id: string; seq: number; position: number; createdAt: string; updatedAt: string }

/** Presentation order only; persisted manual positions remain untouched. */
export class ColumnSorting {
  public static valid(value: unknown): value is ColumnSort {
    return COLUMN_SORT_OPTIONS.some(option => option.value === value);
  }
  public static compare(a: SortableTask, b: SortableTask, mode: ColumnSort): number {
    if (mode !== 'manual') {
      const field = mode.startsWith('created-') ? 'createdAt' : 'updatedAt';
      const first = Date.parse(a[field]), second = Date.parse(b[field]);
      // Missing/invalid dates always come last, independently of direction.
      if (Number.isNaN(first) !== Number.isNaN(second)) return Number.isNaN(first) ? 1 : -1;
      const diff = first - second;
      if (Number.isFinite(diff) && diff !== 0) return mode.endsWith('-asc') ? diff : -diff;
    }
    return a.position - b.position || a.seq - b.seq || a.id.localeCompare(b.id);
  }
}
