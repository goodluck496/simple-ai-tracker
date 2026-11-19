import { AgentRole, type AgentProfile, type AutomationSettings } from './contracts.js';

export interface AcceptanceCriterion { id: string; requirement: string; method: 'unit' | 'integration' | 'browser' | 'manual'; }
export interface TaskBrief { goal: string; scope: string; criteria: AcceptanceCriterion[]; }
export interface RoutingDecision {
  version: 1; complexity: 'simple' | 'normal' | 'complex'; risk: 'low' | 'medium' | 'high';
  uncertainty: 'low' | 'medium' | 'high'; reason: string; brief: TaskBrief;
  assignments: { stage: number; profileId: string; reason: string }[];
}
export interface RoutingSnapshot { decision: RoutingDecision; sourceDescription: string; createdAt: string; }
export interface AcceptanceResult {
  id: string;
  status: 'passed' | 'failed' | 'manual';
  evidence: string;
  checkPosition?: number;
  source?: {
    checkId: string;
    eventId: number;
    sha: string;
    attempt: number;
    browser?: { action: string; assertion: string; actual: string; imageUrl: string };
  };
}
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;

/** Validate model suggestions before they can influence a run. Never grants new stages or budgets. */
export class TaskRouting {
  public static parse(content: string, settings: AutomationSettings, routerStage: number): RoutingDecision {
    if (content.length > 24000) throw new Error('Router output exceeds 24000 characters.');
    const value = JSON.parse(content) as RoutingDecision;
    if (!value || value.version !== 1 || !['simple', 'normal', 'complex'].includes(value.complexity)
      || !['low', 'medium', 'high'].includes(value.risk) || !['low', 'medium', 'high'].includes(value.uncertainty)
      || !text(value.reason) || !value.brief || !text(value.brief.goal) || !text(value.brief.scope)
      || !Array.isArray(value.brief.criteria) || !value.brief.criteria.length || value.brief.criteria.length > 30
      || !Array.isArray(value.assignments) || value.assignments.length > settings.pipeline.length) throw new Error('Invalid router decision.');
    const ids = new Set<string>();
    for (const item of value.brief.criteria) {
      if (!item || !/^AC-[1-9]\d{0,2}$/.test(item.id) || ids.has(item.id) || !text(item.requirement)
        || !['unit', 'integration', 'browser', 'manual'].includes(item.method)) throw new Error('Invalid acceptance criteria.');
      ids.add(item.id);
    }
    const stages = new Set<number>();
    for (const assignment of value.assignments) {
      const original = settings.agents.find(p => p.id === settings.pipeline[assignment?.stage]);
      const selected = settings.agents.find(p => p.id === assignment?.profileId);
      if (!assignment || !Number.isSafeInteger(assignment.stage) || assignment.stage <= routerStage || stages.has(assignment.stage)
        || !original || !selected || original.role !== selected.role || !settings.routingProfileIds?.includes(selected.id)
        || !text(assignment.reason) || !selected.model.trim()) throw new Error('Router selected an unapproved or incompatible profile.');
      stages.add(assignment.stage);
    }
    // Reconstruct only recognized fields; arbitrary model fields never reach persisted configuration.
    return { version: 1, complexity: value.complexity, risk: value.risk, uncertainty: value.uncertainty, reason: value.reason,
      brief: { goal: value.brief.goal, scope: value.brief.scope, criteria: value.brief.criteria.map(({id, requirement, method}) => ({id, requirement, method})) },
      assignments: value.assignments.map(({stage, profileId, reason}) => ({stage, profileId, reason})) };
  }
  public static profile(settings: AutomationSettings, stage: number, snapshot?: RoutingSnapshot): AgentProfile {
    const original = settings.agents.find(p => p.id === settings.pipeline[stage])!;
    const selected = snapshot?.decision.assignments.find(a => a.stage === stage);
    if (!selected) return original;
    const profile = settings.agents.find(p => p.id === selected.profileId);
    if (!profile || profile.role !== original.role || !settings.routingProfileIds?.includes(profile.id)) throw new Error('Stored routing profile is no longer valid.');
    return profile;
  }
  public static acceptance(content: string, brief: TaskBrief): AcceptanceResult[] {
    const value = JSON.parse(content) as { results?: AcceptanceResult[] };
    if (!value || !Array.isArray(value.results) || value.results.length !== brief.criteria.length) throw new Error('Report must cover every acceptance criterion.');
    const ids = new Set<string>();
    for (const item of value.results) {
      const criterion = brief.criteria.find(c => c.id === item?.id);
      if (!criterion || ids.has(item.id) || !text(item.evidence) || !['passed', 'failed', 'manual'].includes(item.status)
        || (item.status === 'manual' && criterion.method !== 'manual') || (criterion.method === 'manual' && item.status !== 'manual')) throw new Error('Invalid acceptance result.');
      ids.add(item.id);
    }
    return value.results.map(({ id, status, evidence, checkPosition }) => ({ id, status, evidence,
      ...(status !== 'manual' && Number.isSafeInteger(checkPosition) && checkPosition! >= 0 ? { checkPosition } : {}) }));
  }
  public static readonly instructions = 'Return plan as a JSON string containing {version:1,complexity:"simple|normal|complex",risk:"low|medium|high",uncertainty:"low|medium|high",reason:"evidence-based explanation",brief:{goal:"observable outcome",scope:"boundaries",criteria:[{id:"AC-1",requirement:"observable behavior",method:"unit|integration|browser|manual"}]},assignments:[{stage:1,profileId:"approved profile ID",reason:"why"}]}. Stage indexes are zero-based. Assign only future stages to explicitly approved profiles of the SAME role. Empty assignments preserves all profiles. Never invent model capabilities or requirements, change budgets, or write sources. Ask questions for missing user decisions. Browser criteria require actual interaction and assertions; manual criteria are reserved for checks requiring human input. Inspect focused code when needed. High uncertainty requires questions or an analyst stage before development.';
}
