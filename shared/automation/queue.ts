import { AUTOMATION_TIMING, RunStatus, type AgentRole, type RunnerId } from './contracts.js';
import type { TaskStatus } from '../tasks/status.js';
import type { HostStatus } from './project.js';
import type { UsageSummary } from './token-usage.js';
import { RunConsoleDecoder } from './console.js';

export const RunPhase = { Preparing: 'preparing', WaitingSlot: 'waiting-slot', Setup: 'setup', Agent: 'agent', Checks: 'checks', Merge: 'merge' } as const;
export type RunPhase = typeof RunPhase[keyof typeof RunPhase];
export const RUN_PHASES = Object.values(RunPhase);
export const RUN_PHASE_TITLES: Record<RunPhase, string> = { preparing: 'Подготовка рабочей ветки', 'waiting-slot': 'Ожидание слота проекта', setup: 'Установка зависимостей', agent: 'Работа агента', checks: 'Проверки worker', merge: 'Squash-интеграция' };
export const RUN_STATUS_TITLES: Record<RunStatus, string> = { queued: 'В очереди', running: 'Выполняется', integrating: 'Squash-интеграция', merge_blocked: 'Слияние заблокировано', waiting: 'Ждёт ответа', review: 'Готов к проверке', failed: 'Ошибка', cancelled: 'Остановлен', interrupted: 'Связь потеряна', merged: 'Слит локально' };
export const QUEUE_LIMITS = { recent: 100, quietMs: 120000, previewChars: 1200 } as const;
export const INTEGRATION_STATE_TITLES = { preparing: 'Подготовка squash', resolving: 'Разрешение конфликтов', checking: 'Проверка объединённого результата',
  ready: 'Кандидат проверен', publishing: 'Применение в целевую ветку', merged: 'Squash применён', blocked: 'Нужна проверка слияния' } as const;
export const RUN_EVENT_TITLES: Record<string, string> = { queued: 'Поставлен в очередь', stage: 'Начало этапа', phase: 'Операция worker',
  progress: 'Прогресс', pass: 'Этап пройден', changes_requested: 'Нужны исправления', questions: 'Нужен ответ', failed: 'Ошибка',
  resumed: 'Продолжение', restarted: 'Новый запуск', cancelled: 'Остановка', interrupted: 'Связь потеряна' };
export const QueueLane = { Queued: 'queued', Running: 'running', Attention: 'attention', Finished: 'finished' } as const;
export type QueueLane = typeof QueueLane[keyof typeof QueueLane];
export const QUEUE_LANES = [
  { id: QueueLane.Queued, title: 'Ожидают' }, { id: QueueLane.Running, title: 'Выполняются' },
  { id: QueueLane.Attention, title: 'Требуют внимания' }, { id: QueueLane.Finished, title: 'Завершены' },
] as const;
export interface QueueItem {
  cleanup?: import('./cleanup.js').CleanupState;
  checkout?: import('./contracts.js').AgentRun['checkout'];
  integration?: import('./contracts.js').IntegrationInfo;
  integrationSourceSha?: string;
  tokenUsage?: UsageSummary;
  id: string; taskId: string; title: string; taskStatus: TaskStatus; status: RunStatus; stage: number; revision: number;
  pipeline: { role: AgentRole; runner: RunnerId; model: string }[];
  phase?: RunPhase; phaseStartedAt?: string; heartbeatAt?: string; progressAt?: string; lastMessage: string;
  createdAt: string; startedAt?: string; attemptStartedAt?: string; finishedAt?: string; updatedAt: string;
  summary: string; workerId: string | null; branch: string | null; timeoutMinutes: number;
  queuePosition?: number; openQuestions: number; canResume: boolean; canRestart: boolean; actionReason: string;
  restartedFromId?: string;
}
export interface QueueSnapshot { items: QueueItem[]; host: HostStatus; serverTime: string; }

/** Display structured CLI events without dumping JSON envelopes into the queue. */
export class RunProgressText {
  public static format(text: string): string {
    return RunConsoleDecoder.render([{ id: 0, runId: '', at: '', kind: 'progress', text }]).lines
      .map((line) => line.level === 'command' && line.text.startsWith('$ ') ? `Команда: ${line.text.slice(2)}` : line.text)
      .join('\n').slice(-QUEUE_LIMITS.previewChars);
  }
}
export class QueuePresentation {
  public static lane(item: QueueItem): QueueLane {
    if (item.status === RunStatus.Queued) return QueueLane.Queued;
    if (item.status === RunStatus.Running || item.status === RunStatus.Integrating) return QueueLane.Running;
    return item.status === RunStatus.Waiting || item.status === RunStatus.Failed || item.status === RunStatus.Interrupted || item.status === RunStatus.MergeBlocked ? QueueLane.Attention : QueueLane.Finished;
  }
  public static health(item: QueueItem, now: number, host: HostStatus): string {
    if (item.status === RunStatus.Queued) return host.online ? 'Ожидает свободного слота worker.' : 'Нет подключённого worker. Подключите компьютер в настройках команды.';
    if (item.phase === RunPhase.WaitingSlot && item.status === RunStatus.Running) return 'Worker удерживает lease и ожидает слота проекта. Ожидание не расходует активный бюджет.';
    if (item.status === RunStatus.Waiting) return 'Выполнение остановлено до ответа на вопросы в карточке задачи.';
    if (item.status === RunStatus.Interrupted) return 'Lease worker истёк. Убедитесь, что старый процесс остановлен, затем продолжите запуск.';
    if (item.status === RunStatus.Failed || item.status === RunStatus.MergeBlocked) return item.summary || 'Запуск завершился с ошибкой. Откройте журнал.';
    if (item.status !== RunStatus.Running && item.status !== RunStatus.Integrating) return RUN_STATUS_TITLES[item.status];
    if (!item.heartbeatAt || now - Date.parse(item.heartbeatAt) > AUTOMATION_TIMING.leaseMs) return 'Нет свежего heartbeat этого запуска. Проверяется потеря связи с worker.';
    if (now - Date.parse(item.progressAt ?? item.phaseStartedAt ?? item.updatedAt) > QUEUE_LIMITS.quietMs) return 'Worker на связи, но новых событий давно нет. Агент или команда могут ещё работать; это не доказательство зависания.';
    return 'Worker на связи. Выполнение продолжается.';
  }
}
