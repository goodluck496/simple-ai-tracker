/** Форматирование дат и размеров без сторонних библиотек. */

const MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 19.10.2026 14:20 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = parse(iso);
  if (!date) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 19 окт */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = parse(iso);
  if (!date) return '—';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** «сегодня 14:20», «вчера», «5 дн. назад», «12.03.» */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = parse(iso);
  if (!date) return '—';

  const now = new Date();
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (dayDiff === 0) {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `сегодня ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (dayDiff === 1) return 'вчера';
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} дн. назад`;
  if (dayDiff >= 7 && dayDiff < 365) return formatShortDate(iso);
  return `${date.getDate()}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

/** 1,4 КБ / 512 Б */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 Б';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}
