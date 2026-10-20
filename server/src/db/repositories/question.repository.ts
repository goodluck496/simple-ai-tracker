import type { SqlDatabase } from '../sql-database.js';
import type { NewQuestion, QuestionRepository } from '../../domain/ports.js';
import type { TaskQuestion } from '../../domain/entities.js';
import { mapQuestion, type QuestionRow } from '../rows.js';

export class SqliteQuestionRepository implements QuestionRepository {
  public constructor(private readonly db: SqlDatabase) {}

  public add(question: NewQuestion): TaskQuestion {
    const result = this.db
      .prepare(
        'INSERT INTO task_questions (task_id, text, phase, asked_by, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([question.taskId, question.text, question.phase, question.askedBy, question.createdAt]);

    const row = this.db
      .prepare('SELECT * FROM task_questions WHERE id = ?')
      .get<QuestionRow>([result.lastInsertRowId]);
    if (!row) throw new Error('Не удалось сохранить вопрос');
    return mapQuestion(row);
  }

  public listByTask(taskId: string): TaskQuestion[] {
    return this.db
      .prepare('SELECT * FROM task_questions WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all<QuestionRow>([taskId])
      .map(mapQuestion);
  }

  public findById(questionId: number): TaskQuestion | null {
    const row = this.db.prepare('SELECT * FROM task_questions WHERE id = ?').get<QuestionRow>([questionId]);
    return row ? mapQuestion(row) : null;
  }

  public answer(questionId: number, answer: string, answeredBy: string, answeredAt: string): TaskQuestion | null {
    this.db
      .prepare('UPDATE task_questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?')
      .run([answer, answeredBy, answeredAt, questionId]);
    return this.findById(questionId);
  }

  public removeById(questionId: number): boolean {
    const result = this.db.prepare('DELETE FROM task_questions WHERE id = ?').run([questionId]);
    return result.changes > 0;
  }

  public countOpen(taskId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM task_questions
         WHERE task_id = ? AND (answer IS NULL OR TRIM(answer) = '')`,
      )
      .get<{ total: number }>([taskId]);
    return row?.total ?? 0;
  }
}
