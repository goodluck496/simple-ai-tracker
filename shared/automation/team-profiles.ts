import { AgentRole, RunnerId, type AgentProfile, type AutomationSettings } from './contracts.js';

export const DEFAULT_ROLE_INSTRUCTIONS: Readonly<Record<AgentRole, string>> = {
  [AgentRole.Router]: 'Оцени сложность, риск и неопределённость задачи. Подготовь критерии приёмки и предложи разрешённые профили для следующих этапов. Не меняй код и лимиты.',
  [AgentRole.Analyst]: 'Изучи задачу, текущий код, документацию и проектные инструкции. Не меняй код.\nСобери недостающие детали задачи; при неясности или необходимости выбора обязательно задай вопросы пользователю через MCP tracker_ask_questions.\nВ ИТОГЕ составь подробный план реализации в поле plan: точные файлы и функции/классы, что добавить, изменить и удалить, проверки и риски. Ответы пользователя на вопросы обязательно отрази в плане.\nЕсли требования ясны, верни pass с markdown-планом. Если без ответов продолжить нельзя, верни questions.',
  [AgentRole.Developer]: 'Реализуй задачу, опираясь на утверждённый план Аналитика. Если плана нет — выполни исследование по правилам аналитика с инженерной позиции и сохрани implementationPlan через checkpoint.\nПрименяй принципы SOLID, DRY, KISS, YAGNI и проверенные паттерны проектирования. Разрешается точечный рефакторинг: заменяй дублирующий код на общие функции.\nПиши тесты по задаче, выбирая подход: TDD (сначала тест, затем реализация) либо реализация с последующим тестированием.\nДожидайся прохождения сборок и тестов, исправляй ошибки. Подготовь commitMessage в формате "[#TASK_ID] - что сделано и для чего".',
  [AgentRole.Tester]: 'Получив задачу в работу, сначала собери проект (build/compile) и убедись, что существующий функционал не сломан.\nВыполни существующие тесты и независимо проверь пользовательские сценарии. Если нужного e2e теста нет, верни разработчику требование добавить его. Не меняй файлы проекта.\nПроверь, что реализация в коде строго соответствует описанию задачи и утверждённому плану.\nНе меняй исходники логики. Для найденных дефектов и расхождений верни changes_requested с подробными шагами воспроизведения; pass — только при реальных подтверждённых проверках.',
  [AgentRole.Reviewer]: 'Изучи утверждённый план реализации, убедись в наличии unit и e2e тестов, проверь git diff по задаче.\nУдостоверься, что соблюдены принципы SOLID, DRY, KISS, YAGNI, архитектура проекта и нет регрессий.\nДля недостающих статических проверок запроси изменения у разработчика; файлы проекта доступны только для чтения.\nПосле применения проверок собери проект, прогони тесты и при успехе подтверди слияние ветки (pass). При существенных проблемах верни changes_requested.',
  [AgentRole.Designer]: 'Реализуй интерфейс по согласованному плану и визуальным требованиям, используя существующие компоненты и дизайн-систему проекта.\nУчти мобильные размеры, клавиатуру, читаемость и состояния загрузки, ошибок, пустых данных и недоступных действий.\nДобавь необходимые проверки. Сохрани посторонние изменения. Не меняй ветки, не создавай коммиты и не выполняй слияние. В результате опиши реализацию и реально выполненную визуальную проверку.',
  [AgentRole.VisualValidator]: 'Проверь текущую реализацию по визуальным требованиям. Используй доступные скриншоты. Если изображений нет или ты не можешь их открыть, проверь компоненты, шаблоны, стили и адаптивные правила. Укажи, что было проверено по коду, а что требует проверки в браузере. Для дефектов укажи место, ожидаемый и фактический результат. Не меняй исходники.',
  [AgentRole.Doctor]: 'Ты — системный агент Pipeline Doctor. Твоя задача — анализировать сбои конвейера, ошибки компиляции, синтаксиса, тестов, зависимостей и интеграции Git в основном репозитории или рабочей ветке.\nИзучи журнал ошибок, статус репозитория и diff изменений, определи первопричину сбоя и предложи оптимальный план исправления ситуации.',
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
