export const AutomationTab = { Project: 'project', Resources:'resources', Models: 'models', Team: 'team', Budgets: 'budgets', Launch: 'launch' } as const;
export type AutomationTab = typeof AutomationTab[keyof typeof AutomationTab];
export const AUTOMATION_TABS = [
  { value:AutomationTab.Resources, label:'Навыки и MCP' },
  { value: AutomationTab.Project, label: 'Компьютер и проект' }, { value: AutomationTab.Models, label: 'Модели' },
  { value: AutomationTab.Team, label: 'Команда и этапы' }, { value: AutomationTab.Budgets, label: 'Лимиты и бюджеты' }, { value: AutomationTab.Launch, label: 'Запуск' },
] as const;
