import { ChangeDetectionStrategy, Component, ElementRef, NgZone, afterRenderEffect, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { PanelModule } from 'primeng/panel';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { RunEvent } from '../../../../../shared/automation/contracts';
import { CONSOLE_LIMITS, RunConsoleDecoder } from '../../../../../shared/automation/console';

@Component({
  selector: 'sat-run-console',
  standalone: true,
  imports: [DatePipe, FormsModule, ButtonModule, SelectModule, PanelModule, DialogModule, InputTextModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './run-console.component.html',
  styleUrl: './run-console.component.scss'
})
export class RunConsoleComponent {
  private readonly http = inject(HttpClient);
  private readonly ngZone = inject(NgZone);
  public readonly runId = input.required<string>();
  public readonly events = input<readonly RunEvent[]>([]);
  public readonly view = computed(() => RunConsoleDecoder.render(this.events()));
  public readonly level = signal('all');
  public readonly stage = signal('all');
  public readonly searchQuery = signal('');
  public readonly levelOptions = [
    { label: 'Все', value: 'all' },
    { label: 'Ошибки', value: 'error' },
    { label: 'Предупреждения', value: 'warning' },
    { label: 'Команды и операции', value: 'command' },
    { label: 'Успех', value: 'success' },
    { label: 'Сообщения', value: 'info' },
  ];
  public readonly stageOptions = computed(() => [{ label: 'Все этапы', value: 'all' }, ...this.stages().map(value => ({ label: value, value }))]);
  public readonly follow = signal(true);
  public readonly rawOpen = signal(false);
  public readonly message = signal('');
  public readonly downloading = signal(false);
  public readonly stages = computed(() => [...new Set(this.view().lines.map((line) => line.stage))]);

  // Main console rows with search & filters
  public readonly rows = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    const lvl = this.level();
    const stg = this.stage();
    return this.view().lines.filter((line) => {
      if (lvl !== 'all' && line.level !== lvl) return false;
      if (stg !== 'all' && line.stage !== stg) return false;
      if (q && !line.text.toLowerCase().includes(q) && !line.stage.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  public readonly raw = computed(() => this.events().map((event) => JSON.stringify(event)).join('\n'));
  public readonly limit = CONSOLE_LIMITS.lines;
  public readonly viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  public readonly modalViewport = viewChild<ElementRef<HTMLDivElement>>('modalViewport');

  // Detailed Modal State & Filters
  public readonly detailModalOpen = signal(false);
  public readonly detailFilter = signal<'all' | 'error' | 'command' | 'success' | 'warning'>('all');
  public readonly detailStage = signal('all');
  public readonly detailSearch = signal('');

  // Counts for statistics
  public readonly errorCount = computed(() => this.view().lines.filter((l) => l.level === 'error').length);
  public readonly successCount = computed(() => this.view().lines.filter((l) => l.level === 'success').length);
  public readonly commandCount = computed(() => this.view().lines.filter((l) => l.level === 'command').length);
  public readonly warningCount = computed(() => this.view().lines.filter((l) => l.level === 'warning').length);

  // Detailed modal filtered rows
  public readonly detailRows = computed(() => {
    const filter = this.detailFilter();
    const stg = this.detailStage();
    const q = this.detailSearch().toLowerCase().trim();
    return this.view().lines.filter((line) => {
      if (filter !== 'all' && line.level !== filter) return false;
      if (stg !== 'all' && line.stage !== stg) return false;
      if (q && !line.text.toLowerCase().includes(q) && !line.stage.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  private lastRowCount = -1;
  private lastFollow = false;
  private isAutoScrolling = false;

  public constructor() {
    effect(() => {
      this.runId();
      this.level.set('all');
      this.stage.set('all');
      this.searchQuery.set('');
      this.follow.set(true);
      this.rawOpen.set(false);
      this.message.set('');
      this.lastRowCount = -1;
      this.lastFollow = false;
      this.detailModalOpen.set(false);
      this.detailFilter.set('all');
      this.detailStage.set('all');
      this.detailSearch.set('');
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

  public openDetailModal(filter: 'all' | 'error' | 'command' | 'success' | 'warning' = 'all'): void {
    this.detailFilter.set(filter);
    this.detailStage.set(this.stage());
    this.detailSearch.set(this.searchQuery());
    this.detailModalOpen.set(true);
  }

  public closeDetailModal(): void {
    this.detailModalOpen.set(false);
  }

  public scrollToFirstError(): void {
    const container = this.modalViewport()?.nativeElement;
    if (!container) return;
    const errorEl = container.querySelector('.detail-row[data-level="error"]');
    if (errorEl) {
      errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  public scrollToLastError(): void {
    const container = this.modalViewport()?.nativeElement;
    if (!container) return;
    const errorEls = container.querySelectorAll('.detail-row[data-level="error"]');
    if (errorEls.length) {
      errorEls[errorEls.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  public async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.rows().map((line) => `${line.at} [${line.stage}] [${line.level}] ${line.text}`).join('\n'));
      this.message.set('Видимый вывод скопирован.');
    } catch { this.message.set('Копирование недоступно. Выделите текст или скачайте журнал.'); }
  }

  public async copyDetailFiltered(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.detailRows().map((line) => `${line.at} [${line.stage}] [${line.level}] ${line.text}`).join('\n'));
      this.message.set('Отфильтрованные строки скопированы.');
    } catch { this.message.set('Копирование недоступно. Выделите текст.'); }
  }

  public async copyErrors(): Promise<void> {
    try {
      const errors = this.view().lines.filter(l => l.level === 'error');
      await navigator.clipboard.writeText(errors.map((line) => `${line.at} [${line.stage}] [ERROR] ${line.text}`).join('\n'));
      this.message.set(`Скопировано ошибок: ${errors.length}.`);
    } catch { this.message.set('Копирование недоступно.'); }
  }

  public async copyLine(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.message.set('Строка скопирована.');
    } catch { /* ignore */ }
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
