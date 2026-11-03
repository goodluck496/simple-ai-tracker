import { ChangeDetectionStrategy, Component, ElementRef, NgZone, afterRenderEffect, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { RunEvent } from '../../../../../shared/automation/contracts';
import { CONSOLE_LIMITS, RunConsoleDecoder } from '../../../../../shared/automation/console';

@Component({ selector: 'sat-run-console', standalone: true, imports: [DatePipe, FormsModule, ButtonModule, SelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './run-console.component.html', styleUrl: './run-console.component.scss' })
export class RunConsoleComponent {
  private readonly http = inject(HttpClient);
  private readonly ngZone = inject(NgZone);
  public readonly runId = input.required<string>();
  public readonly events = input<readonly RunEvent[]>([]);
  public readonly view = computed(() => RunConsoleDecoder.render(this.events()));
  public readonly level = signal('all');
  public readonly stage = signal('all');
  public readonly levelOptions = [
    { label: 'Все', value: 'all' }, { label: 'Ошибки', value: 'error' }, { label: 'Предупреждения', value: 'warning' },
    { label: 'Команды', value: 'command' }, { label: 'Успех', value: 'success' }, { label: 'Сообщения', value: 'info' },
  ];
  public readonly stageOptions = computed(() => [{ label: 'Все этапы', value: 'all' }, ...this.stages().map(value => ({ label: value, value }))]);
  public readonly follow = signal(true);
  public readonly rawOpen = signal(false);
  public readonly message = signal('');
  public readonly downloading = signal(false);
  public readonly stages = computed(() => [...new Set(this.view().lines.map((line) => line.stage))]);
  public readonly rows = computed(() => this.view().lines.filter((line) => (this.level() === 'all' || line.level === this.level())
    && (this.stage() === 'all' || line.stage === this.stage())));
  public readonly raw = computed(() => this.events().map((event) => JSON.stringify(event)).join('\n'));
  public readonly limit = CONSOLE_LIMITS.lines;
  public readonly viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');

  private lastRowCount = -1;
  private lastFollow = false;
  private isAutoScrolling = false;

  public constructor() {
    effect(() => {
      this.runId();
      this.level.set('all');
      this.stage.set('all');
      this.follow.set(true);
      this.rawOpen.set(false);
      this.message.set('');
      this.lastRowCount = -1;
      this.lastFollow = false;
    });

    // Listen to scroll events outside Angular zone to avoid triggering change detection on every scroll event
    effect((onCleanup) => {
      const element = this.viewport()?.nativeElement;
      if (!element) return;

      const handleScroll = (): void => {
        if (this.isAutoScrolling) {
          this.isAutoScrolling = false;
          return;
        }
        const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        if (this.follow() !== isAtBottom) {
          this.ngZone.run(() => this.follow.set(isAtBottom));
        }
      };

      this.ngZone.runOutsideAngular(() => {
        element.addEventListener('scroll', handleScroll, { passive: true });
      });

      onCleanup(() => {
        element.removeEventListener('scroll', handleScroll);
      });
    });

    afterRenderEffect(() => {
      const rows = this.rows();
      const follow = this.follow();
      const rowCount = rows.length;
      const element = this.viewport()?.nativeElement;
      if (!element) return;

      // Only perform scroll when rows have actually updated or follow was just toggled
      if (follow && (rowCount !== this.lastRowCount || !this.lastFollow)) {
        this.lastRowCount = rowCount;
        this.lastFollow = follow;
        const target = Math.max(0, element.scrollHeight - element.clientHeight);
        if (Math.abs(element.scrollTop - target) > 1) {
          this.isAutoScrolling = true;
          element.scrollTop = target;
        }
      } else {
        this.lastRowCount = rowCount;
        this.lastFollow = follow;
      }
    });
  }

  public latest(): void {
    this.follow.set(true);
    const element = this.viewport()?.nativeElement;
    if (element) {
      this.isAutoScrolling = true;
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    }
  }

  public async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.rows().map((line) => `${line.at} [${line.stage}] [${line.level}] ${line.text}`).join('\n'));
      this.message.set('Видимый вывод скопирован.');
    } catch { this.message.set('Копирование недоступно. Выделите текст или скачайте журнал.'); }
  }

  public async download(): Promise<void> {
    if (this.downloading()) return; this.downloading.set(true);
    try {
      // HttpClient preserves the selected workspace header; an ordinary link would not.
      const blob = await firstValueFrom(this.http.get(`/api/automation/runs/${encodeURIComponent(this.runId())}/log`, { responseType: 'blob' }));
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `run-${this.runId()}.jsonl`; link.click(); URL.revokeObjectURL(url);
    } catch { this.message.set('Не удалось скачать журнал. Повторите попытку.'); }
    finally { this.downloading.set(false); }
  }
}
