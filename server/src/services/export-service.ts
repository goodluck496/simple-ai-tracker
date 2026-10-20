import fs from 'node:fs';
import path from 'node:path';
import type { AppContainer } from '../bootstrap/container.js';

export interface ExportReport {
  readonly outDir: string;
  readonly tasks: number;
  readonly tags: number;
  readonly files: readonly string[];
}

/**
 * Экспорт содержимого БД в переносимый JSON + markdown-карточки.
 *
 * Нужен для бэкапа, переноса между машинами и ревью: SQLite — рабочее
 * хранилище, а JSON-снимок удобно смотреть глазами и диффить.
 */
export class ExportService {
  public constructor(private readonly app: AppContainer) {}

  public exportToJson(outDir: string): ExportReport {
    const target = path.resolve(outDir);
    const tasksDir = path.join(target, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    const summaries = this.app.repos.taskQueries.listSummaries({});
    const files: string[] = [];

    const taskIndex: unknown[] = [];
    for (const summary of summaries) {
      const card = this.app.taskService.getTaskCard(summary.id);
      taskIndex.push(summary);
      const filePath = path.join(tasksDir, `${card.id}.json`);
      fs.writeFileSync(filePath, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
      files.push(path.relative(target, filePath));

      const markdown = renderTaskMarkdown(card);
      const mdPath = path.join(target, 'markdown', `${card.id}.md`);
      fs.mkdirSync(path.dirname(mdPath), { recursive: true });
      fs.writeFileSync(mdPath, markdown, 'utf8');
      files.push(path.relative(target, mdPath));
    }

    fs.writeFileSync(
      path.join(target, 'tasks.json'),
      `${JSON.stringify({ tasks: taskIndex }, null, 2)}\n`,
      'utf8',
    );
    files.push('tasks.json');

    const tags = this.app.repos.tags.listWithStats();
    fs.writeFileSync(path.join(target, 'tags.json'), `${JSON.stringify({ tags }, null, 2)}\n`, 'utf8');
    files.push('tags.json');

    return { outDir: target, tasks: summaries.length, tags: tags.length, files };
  }
}

function renderTaskMarkdown(card: ReturnType<AppContainer['taskService']['getTaskCard']>): string {
  const lines: string[] = [];
  lines.push(`# ${card.id} — ${card.title}`, '');
  lines.push(`- Тип: **${card.type}**`);
  lines.push(`- Статус: **${card.status}**`);
  lines.push(`- Ручное тестирование: ${card.requiresManualTest ? 'да' : 'нет'}`);
  lines.push(`- Теги: ${card.tags.map((tag) => tag.name).join(', ') || '—'}`);
  if (card.parentId) lines.push(`- Родитель: ${card.parentId}`);
  lines.push(`- Создана: ${card.createdAt}`);
  lines.push(`- Обновлена: ${card.updatedAt}`, '');

  if (card.description.trim()) {
    lines.push('## Описание', '', card.description.trim(), '');
  }

  if (card.plan) {
    lines.push(`## План (v${card.plan.version})`, '', card.plan.content.trim(), '');
  }

  if (card.questions.length > 0) {
    lines.push('## Вопросы', '');
    for (const question of card.questions) {
      lines.push(`- [${question.isOpen ? 'открыт' : 'отвечен'}] ${question.text}`);
      if (!question.isOpen) lines.push(`  - Ответ: ${question.answer ?? ''}`);
    }
    lines.push('');
  }

  if (card.comments.length > 0) {
    lines.push('## История', '');
    for (const comment of card.comments) {
      lines.push(`- **${comment.createdAt}** (${comment.author}, ${comment.kind}): ${comment.text.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
