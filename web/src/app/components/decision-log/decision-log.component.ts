import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { TaskEvent } from '../../models/tracker.models';
import { formatDateTime } from '../../shared/format';

interface TimelineEntry {
  readonly id: number;
  readonly createdAt: string;
  readonly type: string;
  readonly typeLabel: string;
  readonly icon: string;
  readonly actor: string;
  readonly summary: string;
  readonly reason: string | null;
  readonly impact: string | null;
  readonly planChanged: boolean;
  readonly significant: boolean;
}

const EVENT_META: Record<string, { label: string; icon: string; significant: boolean }> = {
  created: { label: 'Создана', icon: 'pi pi-plus', significant: true },
  plan_attached: { label: 'План', icon: 'pi pi-bookmark', significant: true },
  clarification: { label: 'Уточнение', icon: 'pi pi-pencil', significant: true },
  status_changed: { label: 'Статус', icon: 'pi pi-sync', significant: true },
  question_asked: { label: 'Вопрос', icon: 'pi pi-question-circle', significant: true },
  question_answered: { label: 'Ответ', icon: 'pi pi-check', significant: true },
  link_added: { label: 'Связь', icon: 'pi pi-link', significant: false },
  link_removed: { label: 'Связь снята', icon: 'pi pi-link', significant: false },
  comment_added: { label: 'Комментарий', icon: 'pi pi-comments', significant: false },
  attachment_added: { label: 'Вложение', icon: 'pi pi-paperclip', significant: false },
  updated: { label: 'Обновление', icon: 'pi pi-refresh', significant: false },
  moved: { label: 'Перемещение', icon: 'pi pi-arrows-v', significant: false },
  deleted: { label: 'Удаление', icon: 'pi pi-trash', significant: false },
};

const ACTOR_LABEL: Record<string, string> = {
  agent: 'Агент',
  user: 'Пользователь',
  system: 'Система',
};

/**
 * Журнал решений карточки: уточнения пользователя, версии плана и смены статусов
 * в хронологии — «что просили → что уточнили → что изменилось».
 */
@Component({
  selector: 'sat-decision-log',
  standalone: true,
  imports: [CommonModule, ButtonModule, MessageModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './decision-log.component.html',
  styleUrl: './decision-log.component.scss',
})
export class DecisionLogComponent {
  public readonly events = input<readonly TaskEvent[]>([]);
  private readonly showAll = signal(false);

  public readonly entries = computed<readonly TimelineEntry[]>(() => {
    const showAll = this.showAll();
    return this.events()
      .map((event) => {
        const meta = EVENT_META[event.type] ?? { label: event.type, icon: 'pi pi-circle-fill', significant: false };
        const reason = typeof event.payload['reason'] === 'string' ? event.payload['reason'] : null;
        const impact = typeof event.payload['impact'] === 'string' ? event.payload['impact'] : null;
        return {
          id: event.id,
          createdAt: event.createdAt,
          type: event.type,
          typeLabel: meta.label,
          icon: meta.icon,
          actor: ACTOR_LABEL[event.actor] ?? event.actor,
          summary: event.summary,
          reason,
          impact,
          planChanged: event.payload['planChanged'] === true,
          significant: meta.significant,
        };
      })
      .filter((entry) => showAll || entry.significant)
      .reverse();
  });

  public readonly hiddenCount = computed(() => {
    const all = this.events().length;
    const significant = this.events().filter((event) => (EVENT_META[event.type]?.significant ?? false)).length;
    return all - significant;
  });

  public readonly showingAll = computed(() => this.showAll());

  public toggleAll(): void {
    this.showAll.update((value) => !value);
  }

  public readonly formatDateTime = formatDateTime;
}
