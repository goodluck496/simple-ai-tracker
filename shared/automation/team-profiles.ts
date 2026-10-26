import { AgentRole, RunnerId, type AgentProfile, type AutomationSettings } from './contracts.js';

export const DEFAULT_ROLE_INSTRUCTIONS: Readonly<Record<AgentRole, string>> = {
  [AgentRole.Analyst]: 'Изучи задачу, текущий код и инструкции проекта. Не меняй файлы.\nСоставь план: цель, шаги реализации, затронутые модули, проверки, риски и критерии приёмки.\nЕсли требования ясны, верни pass и markdown-план в поле plan. Если без уточнения нельзя продолжить, верни questions с конкретными вопросами. Отсутствие ещё не реализованной функции не является ошибкой этапа анализа.',
  [AgentRole.Developer]: 'Реализуй согласованный план, соблюдая архитектуру и инструкции проекта. Сохрани посторонние изменения.\nДобавь необходимые тесты и проверь изменённое поведение. При возврате исправь конкретные замечания тестирования и ревью.\nНе меняй ветки, не создавай коммиты и не выполняй слияние — это делает worker. В результате перечисли изменения, выполненные проверки и оставшиеся ограничения. Не заявляй об успехе без доказательств.',
  [AgentRole.Tester]: 'Независимо проверь реализацию по плану и критериям приёмки. Изучи покрытие и выполни доступные настроенные проверки. Не меняй файлы.\nДля дефекта укажи шаги воспроизведения, ожидаемый и фактический результат, команду и существенный вывод проверки. Недостающие тесты верни разработчику.\nВерни changes_requested для подтверждённых дефектов или существенных пробелов покрытия; pass только при наличии доказательств. Если проверка невозможна из-за отсутствующих данных, явно сообщи об этом.',
  [AgentRole.Reviewer]: 'Независимо оцени diff относительно задачи, согласованного плана и архитектуры проекта. Не меняй файлы.\nПроверь корректность, регрессии, обработку ошибок, сохранность данных и достаточность тестов.\nДля каждого замечания укажи файл или участок, причину, влияние и ожидаемое исправление. Верни changes_requested для существенных подтверждённых проблем, иначе pass. Не выдавай предположения за обнаруженные ошибки.',
  [AgentRole.Designer]: 'Реализуй интерфейс по согласованному плану и визуальным требованиям, используя существующие компоненты и дизайн-систему проекта.\nУчти мобильные размеры, клавиатуру, читаемость и состояния загрузки, ошибок, пустых данных и недоступных действий.\nДобавь необходимые проверки. Сохрани посторонние изменения. Не меняй ветки, не создавай коммиты и не выполняй слияние. В результате опиши реализацию и реально выполненную визуальную проверку.',
  [AgentRole.VisualValidator]: 'Оцени именно предоставленные изображения по визуальным требованиям. Не меняй файлы.\nПроверь читаемость, расположение, переполнения, перекрытия, согласованность стиля и соответствие макету на показанном размере экрана.\nДля каждого замечания укажи изображение, область, проблему и ожидаемый результат. Не делай вывод о работающем поведении только по внешнему виду. Если изображений нет или их недостаточно, верни questions. При подтверждённых проблемах верни changes_requested, иначе pass.',
};

/** Creates distinct profiles and repairs legacy timestamp collisions in an editable draft. */
export class AgentTeamProfiles {
  public constructor(private readonly id: () => string = () => crypto.randomUUID()) {}
  public create(role: AgentRole, connectionId: string): AgentProfile {
    return { id: `agent-${this.id()}`, role, runner: RunnerId.Codex, connectionId, model: '', instructions: DEFAULT_ROLE_INSTRUCTIONS[role] };
  }
  public changeRole(agent: AgentProfile, role: AgentRole): void {
    const useDefault = !agent.instructions.trim() || agent.instructions === DEFAULT_ROLE_INSTRUCTIONS[agent.role];
    agent.role = role;
    if (useDefault) agent.instructions = DEFAULT_ROLE_INSTRUCTIONS[role];
  }
  public prepare(input: AutomationSettings): { settings: AutomationSettings; repaired: boolean } {
    const settings = structuredClone(input);
    const groups = new Map<string, string[]>();
    const used = new Set(settings.agents.map((agent) => agent.id));
    let repaired = false;
    for (const agent of settings.agents) {
      const original = agent.id;
      const group = groups.get(original) ?? [];
      if (group.length) {
        const replacement = `agent-${this.id()}`;
        if (used.has(replacement)) throw new Error('Не удалось создать уникальный ID агента.');
        agent.id = replacement; used.add(replacement); repaired = true;
      }
      group.push(agent.id); groups.set(original, group);
      if (!agent.instructions.trim()) agent.instructions = DEFAULT_ROLE_INSTRUCTIONS[agent.role];
    }
    const occurrence = new Map<string, number>();
    settings.pipeline = settings.pipeline.map((id) => {
      const group = groups.get(id);
      if (!group || group.length === 1) return id;
      const index = occurrence.get(id) ?? 0; occurrence.set(id, index + 1);
      return group[Math.min(index, group.length - 1)];
    });
    return { settings, repaired };
  }
}
