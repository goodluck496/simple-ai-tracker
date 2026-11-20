import { randomUUID } from 'node:crypto';
import type { LibrarySkill, SkillBinding, SkillReference, SkillSummary } from '../../../shared/automation/skills.js';
import type { SqlDatabase } from '../db/sql-database.js';
import type { Repositories } from '../domain/ports.js';
import { TrackerError } from '../core/errors.js';

const STARTER_SKILLS: LibrarySkill[] = [
  { id: 'regression-tests', version: 1, name: 'Проверка исправления', description: 'При исправлении ошибки или изменении наблюдаемого поведения.',
    content: 'Выбери уровень теста, на котором воспроизводится дефект. Зафиксируй ожидаемый результат. Для исправления подтверди, что тест обнаруживает исходную ошибку и проходит с правкой. Укажи тест и проверенное требование в отчёте.' },
  { id: 'browser-acceptance', version: 1, name: 'Приёмка интерфейса в Playwright', description: 'Когда критерий требует взаимодействия с работающим интерфейсом.',
    content: 'Открой предоставленный воркером URL или запусти настроенный e2e-сценарий. Выполни действие пользователя и проверь наблюдаемый результат. Для визуального критерия открой нужное состояние на требуемом размере экрана, просмотри его и сохрани PNG в .sat/screenshots/. При расхождении укажи шаги, ожидаемый и фактический результат.' },
];
const INDEX = 'agent_skill_library_index';

/** Shared by the workspaces of one tracker. Queued runs reference immutable versions. */
export class SkillLibrary {
  constructor(private readonly store: () => { db: SqlDatabase; repos: Repositories }) {}

  public list(): SkillSummary[] {
    return JSON.parse(this.store().repos.meta.get(INDEX) ?? 'null') ?? STARTER_SKILLS.map(({ content, ...summary }) => summary);
  }
  public read({ id, version }: SkillReference): LibrarySkill {
    const stored = this.store().repos.meta.get(`agent_skill:${id}:${version}`);
    if (stored) return JSON.parse(stored);
    const starter = STARTER_SKILLS.find(skill => skill.id === id && skill.version === version);
    if (!starter) throw new TrackerError('SKILL_NOT_FOUND', 'Версия навыка не найдена.');
    return { ...starter };
  }
  public save(input: unknown, id?: string): LibrarySkill {
    const draft = input as Partial<LibrarySkill> | null;
    const field = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
    if (!draft || !field(draft.name, 100) || !field(draft.description, 320) || !field(draft.content, 16000)) {
      throw new TrackerError('VALIDATION_FAILED', 'Заполните название (до 100 символов), условие применения (до 320) и инструкцию (до 16000).');
    }
    if (draft.sourceUrl !== undefined && (!field(draft.sourceUrl, 2048) || !URL.canParse(draft.sourceUrl)
      || new URL(draft.sourceUrl).protocol !== 'https:' || new URL(draft.sourceUrl).username || new URL(draft.sourceUrl).password)) {
      throw new TrackerError('VALIDATION_FAILED', 'Укажите HTTPS-ссылку на источник.');
    }
    const fields = { name: draft.name.trim(), description: draft.description.trim(), content: draft.content.trim(),
      ...(draft.sourceUrl ? {sourceUrl: draft.sourceUrl} : {}) };
    const { db, repos } = this.store();
    return db.transaction(() => {
      const index = this.list();
      const old = index.find(skill => skill.id === id);
      if (id && !old) throw new TrackerError('SKILL_NOT_FOUND', 'Навык не найден.');
      if (old && old.version !== draft.version) throw new TrackerError('CONFLICT', 'Навык уже изменён. Откройте актуальную версию.');
      const skill = { id: id ?? randomUUID(), version: (old?.version ?? 0) + 1, ...fields };
      const { content, ...summary } = skill;
      repos.meta.set(`agent_skill:${skill.id}:${skill.version}`, JSON.stringify(skill));
      repos.meta.set(INDEX, JSON.stringify(old ? index.map(item => item.id === id ? summary : item) : [...index, summary]));
      return skill;
    });
  }
  public versions(bindings: SkillBinding[]): SkillReference[] {
    const index = this.list();
    return bindings.map(({ skillId }) => {
      const skill = index.find(item => item.id === skillId);
      if (!skill) throw new TrackerError('VALIDATION_FAILED', 'Неизвестный навык проекта: ' + skillId);
      return { id: skill.id, version: skill.version };
    });
  }
}
