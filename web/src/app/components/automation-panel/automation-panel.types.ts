export const AutomationTab = {
  Launch: 'launch', Team: 'team', Pipeline: 'pipeline', System: 'system', Budgets: 'budgets',
  Models: 'models', Worker: 'worker', Project: 'project', Checks: 'checks', Resources: 'resources',
} as const;
export type AutomationTab = typeof AutomationTab[keyof typeof AutomationTab];

export const AUTOMATION_TABS = [
  { value: AutomationTab.Launch, label: 'Запуск', icon: 'pi-bolt', task: true },
  { value: AutomationTab.Team, label: 'Команда агентов', icon: 'pi-users', task: true },
  { value: AutomationTab.Pipeline, label: 'Этапы и маршруты', icon: 'pi-sitemap', task: true },
  { value: AutomationTab.System, label: 'Системные роли', icon: 'pi-shield', task: false },
  { value: AutomationTab.Budgets, label: 'Лимиты и бюджеты', icon: 'pi-sliders-h', task: true },
  { value: AutomationTab.Models, label: 'Подключения моделей', icon: 'pi-server', task: false },
  { value: AutomationTab.Worker, label: 'Компьютер и worker', icon: 'pi-desktop', task: false },
  { value: AutomationTab.Project, label: 'Репозиторий и Git', icon: 'pi-folder-open', task: false },
  { value: AutomationTab.Checks, label: 'Проверки и команды', icon: 'pi-check-square', task: false },
  { value: AutomationTab.Resources, label: 'Навыки и MCP', icon: 'pi-book', task: false },
];
