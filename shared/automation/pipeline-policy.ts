import { AgentRole, AUTOMATION_LIMITS, EVIDENCE_AGENT_ROLES, WRITABLE_AGENT_ROLES, type AutomationSettings, type PipelineRoute } from './contracts.js';
import type { FeatureExecution } from './decomposition.js';

/** Execution is derived from selected stages, never from a named team preset. */
export class PipelinePolicy {
  public static configurationProblems(settings: AutomationSettings): string[] {
    const problems: string[] = [];
    const router = this.routerProblem(settings);
    if (router) problems.push(router);
    if (!settings.repositoryPath.trim()) problems.push('Не указана папка Git-проекта. Выберите её в настройках проекта.');
    if (!settings.pipeline.length) problems.push('Не выбраны этапы запуска. Отметьте нужных агентов.');
    if (this.writes(settings) && !settings.checks.length) problems.push('Для изменения кода нужны команды проверок. Настройте их в проекте; для запуска только аналитика они не требуются.');
    const routeProblem = this.routeProblem(settings);
    if (routeProblem) problems.push(routeProblem);
    return problems;
  }
  public static routerProblem(settings: AutomationSettings): string | undefined {
    if (settings.routingProfileIds !== undefined && (!Array.isArray(settings.routingProfileIds) || settings.routingProfileIds.some(id => !settings.agents.some(a => a.id === id)))) return 'Разрешённые профили роутера должны существовать в команде.';
    const roles = this.roles(settings);
    if (!roles.includes(AgentRole.Router)) return;
    if (roles[0] !== AgentRole.Router || roles.filter(r => r === AgentRole.Router).length !== 1) return 'Роутер должен быть единственным первым этапом.';
    if (settings.pipelineRoutes?.some(r => r.passTo !== undefined && this.passStage(settings, settings.pipeline.indexOf(r.from)) !== settings.pipeline.indexOf(r.from) + 1)) return 'Для роутера сохраняйте все этапы проверки: переходы с пропуском этапов запрещены.';
    if (this.writes(settings) && (!roles.includes(AgentRole.Tester) || !roles.includes(AgentRole.Reviewer))) return 'Для маршрутизации кода нужны тестировщик и ревьюер.';
    return;
  }
  /** Router is a preparation step; adding it must not reconnect the terminal gate to it. */
  public static includeStage(settings: AutomationSettings, id: string): AutomationSettings {
    if (settings.pipeline.includes(id)) return settings;
    if (settings.agents.find(a => a.id === id)?.role === AgentRole.Router) return { ...settings, pipeline: [id, ...settings.pipeline] };
    const last = this.executionPath(settings).at(-1);
    const terminal = last === undefined ? undefined : this.route(settings, last);
    return { ...settings, pipeline: [...settings.pipeline, id],
      pipelineRoutes: terminal?.passTo === null ? settings.pipelineRoutes?.map(r => r.from === terminal.from ? { ...r, passTo: id } : r) : settings.pipelineRoutes };
  }
  public static reorder(settings: AutomationSettings, from: number, to: number): AutomationSettings {
    if (![from, to].every(i => Number.isInteger(i) && i >= 0 && i < settings.pipeline.length)) throw new Error('Недопустимая позиция этапа.');
    const pipeline = [...settings.pipeline];
    const [id] = pipeline.splice(from, 1); pipeline.splice(to, 0, id);
    const repairRouterTail = to === 0 && from === settings.pipeline.length - 1 && settings.agents.find(a => a.id === id)?.role === AgentRole.Router;
    const pipelineRoutes = repairRouterTail ? settings.pipelineRoutes?.map((route): PipelineRoute => {
      if (route.passTo !== id) return route;
      const { passTo, ...rest } = route;
      return rest;
    }).filter(r => r.passTo !== undefined || r.retry) : settings.pipelineRoutes;
    const next = { ...settings, pipeline, pipelineRoutes };
    const problem = this.routeProblem(next) ?? this.routerProblem(next);
    if (problem) throw new Error(problem);
    return next;
  }
  public static executionPath(settings: AutomationSettings): number[] {
    const path: number[] = [];
    for (let stage = 0; stage < settings.pipeline.length;) {
      path.push(stage);
      const next = this.passStage(settings, stage);
      if (next <= stage) break;
      stage = next;
    }
    return path;
  }
  public static route(settings: AutomationSettings, stage: number): PipelineRoute | undefined {
    return settings.pipelineRoutes?.find(route => route.from === settings.pipeline[stage]);
  }
  public static passStage(settings: AutomationSettings, stage: number): number {
    const target = this.route(settings, stage)?.passTo;
    if (target === undefined) return stage + 1;
    return target === null ? settings.pipeline.length : settings.pipeline.indexOf(target);
  }
  public static isGate(settings: AutomationSettings, stage: number): boolean {
    const role = this.roles(settings)[stage];
    return EVIDENCE_AGENT_ROLES.includes(role) || (settings.checks.length > 0 && this.checkAt(settings, stage));
  }
  public static canPassTo(settings: AutomationSettings, from: number, to: number): boolean {
    if (to <= from || to > settings.pipeline.length) return false;
    const roles = this.roles(settings);
    return roles.slice(from + 1, to).every((role, offset) =>
      EVIDENCE_AGENT_ROLES.includes(role) && !(settings.checks.length && this.checkAt(settings, from + 1 + offset)));
  }
  public static canRetryFrom(settings: AutomationSettings, gate: number, writer: number): boolean {
    if (writer < 0 || writer > gate || !WRITABLE_AGENT_ROLES.includes(this.roles(settings)[writer])) return false;
    let stage = writer;
    while (stage < gate) {
      const next = this.passStage(settings, stage);
      if (next <= stage) return false;
      stage = next;
    }
    return stage === gate;
  }
  public static routeProblem(settings: AutomationSettings): string | undefined {
    const routes = settings.pipelineRoutes;
    if (!routes) return;
    if (!Array.isArray(routes) || routes.length > settings.pipeline.length) return 'Задайте по одной связи на каждый этап проверки.';
    if (!routes.length) return;
    if (new Set(settings.pipeline).size !== settings.pipeline.length) return 'Для настройки связей выберите отдельный профиль для каждого этапа.';
    const sources = new Set<string>();
    for (const route of routes) {
      const from = route && settings.pipeline.indexOf(route.from);
      if (typeof from !== 'number' || from < 0 || sources.has(route.from) || !this.isGate(settings, from)) {
        return 'Связь должна начинаться с выбранного этапа проверки. Проверьте источники связей.';
      }
      sources.add(route.from);
      if (route.passTo !== undefined && !this.canPassTo(settings, from, this.passStage(settings, from))) {
        return 'Успешный переход должен идти вперёд и сохранять этапы реализации и обязательные команды worker.';
      }
      if (route.retry !== undefined && (!route.retry || !Number.isSafeInteger(route.retry.limit)
        || route.retry.limit < 0 || route.retry.limit > AUTOMATION_LIMITS.revisions.max
        || !['stop', 'ask'].includes(route.retry.exhausted))) {
        return 'Укажите лимит возвратов от 0 до 10 и действие после его исчерпания.';
      }
    }
    for (const route of routes) {
      if (route.retry && !this.canRetryFrom(settings, settings.pipeline.indexOf(route.from), settings.pipeline.indexOf(route.retry.to))) {
        return 'Возврат должен вести к этапу реализации, после которого повторится исходная проверка.';
      }
    }
    return undefined;
  }
  public static routesFor(settings: AutomationSettings, pipeline: string[]): PipelineRoute[] | undefined {
    return settings.pipelineRoutes?.filter(route => pipeline.includes(route.from)).map(route => ({
      from: route.from,
      ...(route.passTo === null || (route.passTo && pipeline.includes(route.passTo)) ? { passTo: route.passTo } : {}),
      ...(route.retry && pipeline.includes(route.retry.to) ? { retry: route.retry } : {}),
    })).filter(route => route.passTo !== undefined || route.retry);
  }
  public static roles(settings: AutomationSettings): AgentRole[] { return settings.pipeline.flatMap(id => { const agent = settings.agents.find(agent => agent.id === id); return agent ? [agent.role] : []; }); }
  public static writes(settings: AutomationSettings): boolean { return this.roles(settings).some(role => WRITABLE_AGENT_ROLES.includes(role)); }
  public static revisionStage(settings: AutomationSettings, stage: number, retryWriterCheck: boolean, feature?: FeatureExecution): number {
    if (retryWriterCheck) return stage;
    return feature?.children.find(child => child.developerStage === stage || child.reviewerStage === stage)?.developerStage
      ?? feature?.finalDeveloperStage
      ?? settings.pipeline.findIndex(id => settings.agents.some(agent => agent.id === id && WRITABLE_AGENT_ROLES.includes(agent.role)));
  }
  public static checkAt(settings: AutomationSettings, stage: number): boolean {
    const roles = this.roles(settings);
    if (roles[stage] === AgentRole.Tester) return true;
    return WRITABLE_AGENT_ROLES.includes(roles[stage]) && !roles.slice(stage + 1).some(role => WRITABLE_AGENT_ROLES.includes(role) || role === AgentRole.Tester);
  }
  public static canDecompose(settings: AutomationSettings): boolean { return !settings.pipelineRoutes?.length && this.roles(settings).join(',') === [AgentRole.Analyst, AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer].join(','); }
  public static needsPlan(settings: AutomationSettings, hasPlan: boolean): boolean {
    const roles = this.roles(settings); const writer = roles.findIndex(role => WRITABLE_AGENT_ROLES.includes(role));
    return !hasPlan && writer >= 0 && roles[writer] !== AgentRole.Developer && !roles.slice(0, writer).includes(AgentRole.Analyst);
  }
}
