export interface RunTimestamps {
  id: string;
  startedAt?: string;
  attemptStartedAt?: string;
  finishedAt?: string;
}

export function formatQueueDate(value: string | undefined, locale?: string, timeZone?: string): string {
  if (!value) return 'Неизвестно';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Неизвестно';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short', timeZone,
  }).format(timestamp);
}

function latestRunTimestamp(run: RunTimestamps): number | null {
  const timestamps = [run.startedAt, run.attemptStartedAt, run.finishedAt]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function sortRunHistory<T extends RunTimestamps>(runs: readonly T[]): T[] {
  return [...runs].sort((left, right) => {
    const leftAt = latestRunTimestamp(left);
    const rightAt = latestRunTimestamp(right);
    if (leftAt === null || rightAt === null) {
      if (leftAt !== rightAt) return leftAt === null ? 1 : -1;
    } else if (leftAt !== rightAt) return rightAt - leftAt;
    return left.id.localeCompare(right.id);
  });
}
