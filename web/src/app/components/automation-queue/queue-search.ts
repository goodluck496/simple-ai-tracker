export interface QueueSearchItem {
  readonly taskId: string;
  readonly title: string;
  readonly id: string;
}

export function filterQueueItems<T extends QueueSearchItem>(items: readonly T[], query: string): T[] {
  const normalized = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) => `${item.taskId} ${item.title} ${item.id}`.toLocaleLowerCase().replace(/\s+/g, ' ').includes(normalized));
}
