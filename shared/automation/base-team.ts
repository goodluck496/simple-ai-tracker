import type { AutomationSettings } from './contracts.js';

const teamKeys = ['agents', 'connections', 'pipeline', 'pipelineRoutes', 'routingProfileIds',
  'skillBindings', 'mcpServers', 'doctorAgent', 'doctorConnectionId', 'doctorModel', 'auditAgent'] as const;
export type BaseTeam = Pick<AutomationSettings, typeof teamKeys[number]>;
export interface BaseTeamState {
  revision: number;
  team: BaseTeam | null;
  mode: 'independent' | 'inherited' | 'custom' | 'conflict';
}

export function teamFrom(settings: BaseTeam): BaseTeam {
  return Object.fromEntries(teamKeys.map(key => [key, settings[key]])) as BaseTeam;
}

export function applyTeam(settings: AutomationSettings, team: BaseTeam): AutomationSettings {
  return { ...settings, ...structuredClone(teamFrom(team)) };
}
