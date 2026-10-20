import type { Logger } from '../core/logger.js';
import type { BackupService } from './backup-service.js';

export interface BackupSchedulerOptions {
  readonly enabled: boolean;
  /** Минимальный интервал между автоматическими бэкапами, часы. */
  readonly intervalHours: number;
  /** Максимум автоматических бэкапов за сутки. */
  readonly maxPerDay?: number;
  readonly keep: number;
}

const MIN_INTERVAL_HOURS = 0.05;

/** Ключ календарного дня (локальное время) — по нему считается суточный лимит. */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Периодические бэкапы базы: снимок при старте и далее по интервалу, но не чаще
 * суточного лимита (`maxPerDay`, по умолчанию 2 раза в день).
 *
 * Пропуск действует только для автоматических снимков: ручной бэкап из панели или
 * CLI создаётся всегда. Ошибки бэкапа не должны валить сервер — они логируются.
 */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly backup: BackupService,
    private readonly options: BackupSchedulerOptions,
    private readonly logger?: Logger,
  ) {}

  public start(): void {
    if (!this.options.enabled) {
      this.logger?.info('Автоматические бэкапы отключены (SAT_BACKUP_ENABLED=false)');
      return;
    }
    this.runOnce('startup');

    const intervalMs = Math.max(MIN_INTERVAL_HOURS, this.options.intervalHours) * 60 * 60 * 1000;
    this.timer = setInterval(() => this.runOnce('scheduled'), intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Пора ли делать автоматический снимок: не чаще интервала и не больше лимита в сутки. */
  public shouldCreate(now: Date = new Date()): boolean {
    const backups = this.backup.list();
    const latest = backups[0];
    const intervalMs = Math.max(MIN_INTERVAL_HOURS, this.options.intervalHours) * 60 * 60 * 1000;
    if (latest) {
      const age = now.getTime() - Date.parse(latest.createdAt);
      if (Number.isFinite(age) && age < intervalMs) return false;
    }

    const maxPerDay = this.options.maxPerDay ?? 0;
    if (maxPerDay <= 0) return true;
    const today = dayKey(now);
    const todayCount = backups.filter((backup) => {
      const created = new Date(backup.createdAt);
      return !Number.isNaN(created.getTime()) && dayKey(created) === today;
    }).length;
    return todayCount < maxPerDay;
  }

  /** Выполняет один цикл «бэкап + ротация». Возвращает имя созданного бэкапа. */
  public runOnce(reason: string, now?: Date): string | null {
    if (!this.shouldCreate(now)) {
      this.logger?.debug('Бэкап пропущен: сработал лимит расписания', { reason });
      return null;
    }
    try {
      const record = this.backup.create(reason);
      this.backup.prune(this.options.keep);
      return record.name;
    } catch (error) {
      this.logger?.error('Не удалось создать бэкап', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
