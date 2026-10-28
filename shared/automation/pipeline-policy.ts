import { AgentRole, WRITABLE_AGENT_ROLES, type AutomationSettings } from './contracts.js';

/** Execution is derived from selected stages, never from a named team preset. */
export class PipelinePolicy {
  public static roles(settings: AutomationSettings): AgentRole[] { return settings.pipeline.flatMap(id => { const agent = settings.agents.find(agent => agent.id === id); return agent ? [agent.role] : []; }); }
  public static writes(settings: AutomationSettings): boolean { return this.roles(settings).some(role => WRITABLE_AGENT_ROLES.includes(role)); }
  public static checkAt(settings: AutomationSettings, stage: number): boolean {
    const roles = this.roles(settings);
    if (roles[stage] === AgentRole.Tester) return true;
    return WRITABLE_AGENT_ROLES.includes(roles[stage]) && !roles.slice(stage + 1).some(role => WRITABLE_AGENT_ROLES.includes(role) || role === AgentRole.Tester);
  }
  public static canDecompose(settings: AutomationSettings): boolean { return this.roles(settings).join(',') === [AgentRole.Analyst, AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer].join(','); }
  public static needsPlan(settings: AutomationSettings, hasPlan: boolean): boolean {
    const roles = this.roles(settings); const writer = roles.findIndex(role => WRITABLE_AGENT_ROLES.includes(role));
    return !hasPlan && writer >= 0 && !roles.slice(0, writer).includes(AgentRole.Analyst);
  }
}
