import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccordionModule } from 'primeng/accordion';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';
import type { TaskQuestion } from '../../models/tracker.models';
import { formatDateTime } from '../../shared/format';

const PHASE_LABEL: Record<string, string> = {
  planning: 'планирование',
  implementation: 'реализация',
  testing: 'тестирование',
};

/** Вопросы в карточке: пользователь отвечает здесь же (PrimeNG textarea/кнопки/аккордеон). */
@Component({
  selector: 'sat-questions-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AccordionModule,
    ButtonModule,
    InputTextModule,
    MessageModule,
    TagModule,
    TextareaModule,
    TooltipModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './questions-panel.component.html',
  styleUrl: './questions-panel.component.scss',
})
export class QuestionsPanelComponent {
  public readonly questions = input<readonly TaskQuestion[]>([]);
  public readonly disabled = input(false);

  public readonly answered = output<{ questionId: number; answer: string }>();
  /** Добавление нового вопроса пользователем. */
  public readonly asked = output<{ text: string }>();
  /** Удаление вопроса. */
  public readonly removed = output<{ questionId: number }>();

  public readonly questionDraft = signal('');

  public submitQuestion(): void {
    const text = this.questionDraft().trim();
    if (!text) return;
    this.asked.emit({ text });
    this.questionDraft.set('');
  }

  private readonly drafts = signal<Record<number, string>>({});

  public readonly openQuestions = computed(() => this.questions().filter((question) => question.isOpen));
  public readonly answeredQuestions = computed(() => this.questions().filter((question) => !question.isOpen));

  public draftFor(questionId: number): string {
    return this.drafts()[questionId] ?? '';
  }

  public onDraftInput(questionId: number, value: string): void {
    this.drafts.update((current) => ({ ...current, [questionId]: value }));
  }

  public submit(questionId: number): void {
    const value = this.draftFor(questionId).trim();
    if (!value) return;
    this.answered.emit({ questionId, answer: value });
    this.drafts.update((current) => ({ ...current, [questionId]: '' }));
  }

  public phaseLabel(phase: string): string {
    return PHASE_LABEL[phase] ?? phase;
  }

  public readonly formatDateTime = formatDateTime;
}
