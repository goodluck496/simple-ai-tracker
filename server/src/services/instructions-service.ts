import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';

const INSTRUCTIONS_FILE = 'AGENT_INSTRUCTIONS.md';

/**
 * Доступ к жёстким инструкциям для агентов.
 *
 * Инструкции живут в AGENT_INSTRUCTIONS.md рядом с приложением: один файл
 * копируется в инструкцию проекта-потребителя. MCP-сервер отдаёт его целиком
 * через tracker_get_instructions и в поле instructions при инициализации.
 */
export class InstructionsService {
  private cached: string | null = null;

  public constructor(
    private readonly appRoot: string,
    private readonly logger?: Logger,
  ) {}

  public get path(): string {
    return path.join(this.appRoot, INSTRUCTIONS_FILE);
  }

  public get(): string {
    if (this.cached) return this.cached;
    try {
      this.cached = fs.readFileSync(this.path, 'utf8');
      return this.cached;
    } catch (error) {
      this.logger?.warn('Не удалось прочитать AGENT_INSTRUCTIONS.md, используется встроенная версия', {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      this.cached = FALLBACK_INSTRUCTIONS;
      return this.cached;
    }
  }
}

/** Минимальная встроенная версия на случай отсутствия файла. */
const FALLBACK_INSTRUCTIONS = `# Simple AI Tracker — правила для агентов

1. Работай с задачами ТОЛЬКО через MCP-инструменты tracker_*.
2. ЗАПРЕЩЕНО искать данные задач через grep/rg/find/cat, читать tasks/*.json,
   открывать data/tracker.db или обращаться к REST API напрямую.
3. Каждая задача начинается с tracker_get_task: он отдаёт контекст, связи,
   план и историю решений.
4. Вопросы пользователю — только через tracker_ask_questions (статус questions).
5. План — только через tracker_attach_plan (markdown), реализация строго по плану.
6. После реализации — статус testing, тесты, затем review.
7. В done переводит только пользователь.
8. Любое уточнение пользователя — tracker_record_clarification, затем перечитай
   план и при необходимости приложи новую версию плана.
`;
