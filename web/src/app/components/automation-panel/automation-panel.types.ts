export const AutomationTab = { Project: 'project', Models: 'models', Team: 'team', Launch: 'launch' } as const;
export type AutomationTab = typeof AutomationTab[keyof typeof AutomationTab];
export const AUTOMATION_TABS = [
  { value: AutomationTab.Project, label: 'Компьютер и проект' }, { value: AutomationTab.Models, label: 'Модели' },
  { value: AutomationTab.Team, label: 'Команда и этапы' }, { value: AutomationTab.Launch, label: 'Запуск' },
] as const;
