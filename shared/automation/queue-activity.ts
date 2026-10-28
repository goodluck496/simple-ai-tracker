import { AUTOMATION_TIMING, RunStatus } from './contracts.js';
import { QUEUE_LIMITS, RUN_STATUS_TITLES, type QueueItem } from './queue.js';
export const ACTIVITY_TIMING = { tickMs: 1000, snapshotMs: 15000 } as const;

export interface RunActivityState {
  state: 'active' | 'quiet' | 'stale' | 'disconnected' | 'idle';
  animated: boolean; label: string; heartbeatAge?: number; eventAge?: number; phaseAge?: number;
  completed: number; total: number; percent: number | null;
}
/** Heartbeat proves worker liveness, not advancement of the subprocess. */
export class RunActivity {
  public static evaluate(item: QueueItem, now: number, connected: boolean): RunActivityState {
    const age = (at?: string) => at && Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : undefined;
    const total = item.pipeline.length;
    const completed = Math.max(0, Math.min(total, Number.isFinite(item.stage) ? item.stage : 0));
    const result: RunActivityState = { state: 'idle', animated: false, label: RUN_STATUS_TITLES[item.status],
      heartbeatAge: age(item.heartbeatAt), eventAge: age(item.progressAt ?? item.phaseStartedAt),
      phaseAge: age(item.phaseStartedAt), completed, total, percent: total ? Math.floor(completed * 100 / total) : null };
    if (item.status !== RunStatus.Running && item.status !== RunStatus.Integrating) return result;
    if (!connected) return { ...result, state: 'disconnected', label: 'Нет связи с сервером — состояние не подтверждено' };
    if (result.heartbeatAge === undefined || result.heartbeatAge > AUTOMATION_TIMING.leaseMs)
      return { ...result, state: 'stale', label: result.heartbeatAge === undefined ? 'Ожидаем первый ответ worker' : 'Давно нет ответа worker — проверяется связь' };
    if (result.eventAge !== undefined && result.eventAge > QUEUE_LIMITS.quietMs)
      return { ...result, state: 'quiet', animated: true, label: 'Worker отвечает, новых событий от операции давно нет' };
    return { ...result, state: 'active', animated: true, label: 'Worker отвечает' };
  }
  public static elapsed(ms?: number): string {
    if (ms === undefined || !Number.isFinite(ms)) return 'нет данных';
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + ' с';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' мин ' + seconds % 60 + ' с';
    return Math.floor(seconds / 3600) + ' ч ' + Math.floor(seconds % 3600 / 60) + ' мин';
  }
}
