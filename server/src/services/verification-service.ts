import fs from 'node:fs';
import path from 'node:path';
import type { TrackerConfig } from '../core/config.js';
import type { Repositories } from '../domain/ports.js';
import type { TaskService } from './task-service.js';
import type { TaskStatus } from '../domain/task-status.js';

export interface VerificationReport {
  readonly id: string;
  readonly valid: boolean;
  readonly title: string;
  readonly status: TaskStatus;
  readonly plan: {
    readonly present: boolean;
    readonly version: number | null;
    readonly size: number;
    readonly sourcePath: string | null;
    readonly fileExists: boolean | null;
    readonly fileSize: number | null;
  };
  readonly questions: { readonly total: number; readonly open: number };
  readonly counts: {
    readonly comments: number;
    readonly attachments: number;
    readonly images: number;
    readonly links: number;
    readonly subtasks: number;
    readonly planVersions: number;
  };
  readonly encoding: 'ok' | 'issues';
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

const STATUSES_REQUIRING_PLAN: readonly TaskStatus[] = ['ready', 'in_progress', 'testing', 'review', 'done'];

/**
 * Компактная проверка целостности карточки.
 * Заменяет `git diff tasks.json` и ручной просмотр файлов: агент получает
 * короткий JSON-отчёт вместо тысяч строк вывода.
 */
export class VerificationService {
  public constructor(
    private readonly config: TrackerConfig,
    private readonly repos: Repositories,
    private readonly taskService: TaskService,
  ) {}

  public verify(id: string): VerificationReport {
    const task = this.repos.tasks.findById(id);
    if (!task) {
      return {
        id,
        valid: false,
        title: '',
        status: 'backlog',
        plan: { present: false, version: null, size: 0, sourcePath: null, fileExists: null, fileSize: null },
        questions: { total: 0, open: 0 },
        counts: { comments: 0, attachments: 0, images: 0, links: 0, subtasks: 0, planVersions: 0 },
        encoding: 'ok',
        warnings: [],
        errors: [`Задача ${id} не найдена.`],
      };
    }

    const card = this.taskService.getTaskCard(id);
    const plan = card.plan;
    const warnings: string[] = [];
    const errors: string[] = [];

    let fileExists: boolean | null = null;
    let fileSize: number | null = null;
    if (plan?.sourcePath) {
      const absolutePath = path.resolve(this.config.appRoot, '..', '..', plan.sourcePath);
      const candidates = [path.resolve(process.cwd(), plan.sourcePath), absolutePath];
      const existing = candidates.find((candidate) => fs.existsSync(candidate));
      fileExists = Boolean(existing);
      if (existing) {
        fileSize = fs.statSync(existing).size;
        if (fileSize !== plan.content.length && fileSize !== Buffer.byteLength(plan.content, 'utf8')) {
          warnings.push(
            `Файл плана на диске (${fileSize} байт) отличается по размеру от вложения в карточке (${plan.content.length} символов).`,
          );
        }
      } else {
        warnings.push(`Файл плана по пути "${plan.sourcePath}" не найден на диске (вложение в БД сохранено).`);
      }
    }

    if (card.openQuestionsCount > 0 && card.status !== 'questions') {
      errors.push(`В карточке ${card.openQuestionsCount} открытых вопросов, но статус "${card.status}" вместо "questions".`);
    }
    if (card.status === 'questions' && card.openQuestionsCount === 0) {
      warnings.push('Статус "questions", но открытых вопросов нет: карточку пора переводить в ready/planning.');
    }
    if (!plan && STATUSES_REQUIRING_PLAN.includes(card.status)) {
      warnings.push(`Статус "${card.status}" без прикреплённого плана: реализация идёт не по плану.`);
    }
    if (card.status === 'review' && card.requiresManualTest === false) {
      warnings.push('Карточка в review без требования ручного тестирования: пользователь может просто закрыть её в done.');
    }

    const textToCheck = [
      card.title,
      card.description,
      ...card.comments.map((comment) => comment.text),
      ...card.questions.map((question) => `${question.text} ${question.answer ?? ''}`),
      plan?.content ?? '',
    ].join('\n');

    const encodingIssues = /\uFFFD/.test(textToCheck) || /(^|\s)\?{4,}(\s|$)/.test(textToCheck);
    if (encodingIssues) {
      errors.push('Обнаружены признаки повреждённой кодировки (U+FFFD или «????»).');
    }

    return {
      id: card.id,
      valid: errors.length === 0,
      title: card.title,
      status: card.status,
      plan: {
        present: Boolean(plan),
        version: plan?.version ?? null,
        size: plan?.content.length ?? 0,
        sourcePath: plan?.sourcePath ?? null,
        fileExists,
        fileSize,
      },
      questions: { total: card.questions.length, open: card.openQuestionsCount },
      counts: {
        comments: card.comments.length,
        attachments: card.attachments.length,
        images: card.images.length,
        links: card.links.length,
        subtasks: card.subtasks.length,
        planVersions: card.planHistory.length,
      },
      encoding: encodingIssues ? 'issues' : 'ok',
      warnings,
      errors,
    };
  }
}
