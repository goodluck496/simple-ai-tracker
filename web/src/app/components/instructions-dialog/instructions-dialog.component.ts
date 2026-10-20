import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, model, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TooltipModule } from 'primeng/tooltip';
import { TrackerApiService } from '../../services/tracker-api.service';
import { renderMarkdown } from '../../shared/markdown';

/**
 * Модалка с инструкцией для ИИ-агента (AGENT_INSTRUCTIONS.md) и рендером markdown.
 * Тот же текст MCP-сервер отдаёт клиенту в поле `instructions`.
 */
@Component({
  selector: 'sat-instructions-dialog',
  standalone: true,
  imports: [CommonModule, ButtonModule, DialogModule, MessageModule, ProgressSpinnerModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './instructions-dialog.component.html',
  styleUrl: './instructions-dialog.component.scss',
})
export class InstructionsDialogComponent {
  private readonly api = inject(TrackerApiService);

  /** Двусторонняя привязка: крестик PrimeNG закрывает окно через visibleChange. */
  public readonly visible = model(false);
  public readonly closed = output<void>();

  public readonly markdown = signal('');
  public readonly loading = signal(false);
  public readonly failed = signal(false);
  public readonly copied = signal(false);

  private loaded = false;

  public constructor() {
    // Подгружаем инструкцию при первом открытии модалки.
    effect(() => {
      if (this.visible() && !this.loaded) {
        this.loaded = true;
        this.load();
      }
    });
  }

  public readonly rendered = computed(() => renderMarkdown(this.markdown()));

  public load(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.api.getInstructions().subscribe({
      next: (text) => {
        this.markdown.set(text);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  public async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.markdown());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      this.copied.set(false);
    }
  }

  public download(): void {
    const blob = new Blob([this.markdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'AGENT_INSTRUCTIONS.md';
    link.click();
    URL.revokeObjectURL(url);
  }

  public close(): void {
    this.visible.set(false);
    this.closed.emit();
  }
}
