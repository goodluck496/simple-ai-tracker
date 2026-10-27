import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, inject, input, signal, viewChild } from '@angular/core';
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

  public constructor() {
    effect(() => { this.runId(); this.level.set('all'); this.stage.set('all'); this.follow.set(true); this.rawOpen.set(false); this.message.set(''); });
    afterRenderEffect(() => { this.rows(); const element = this.viewport()?.nativeElement; if (element && this.follow()) element.scrollTop = element.scrollHeight; });
  }
  public scroll(): void {
    const element = this.viewport()?.nativeElement;
    if (element) this.follow.set(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
  }
  public latest(): void { this.follow.set(true); const element = this.viewport()?.nativeElement; if (element) element.scrollTop = element.scrollHeight; }
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
