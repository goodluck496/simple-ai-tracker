import { isDeepStrictEqual as equal } from 'node:util';
import { DEFAULT_AUTOMATION_SETTINGS, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { applyTeam, teamFrom, type BaseTeam, type BaseTeamState } from '../../../shared/automation/base-team.js';
import { TrackerError } from '../core/errors.js';
import type { MetaRepository, Repositories } from '../domain/ports.js';
import type { SqlDatabase } from '../db/sql-database.js';
import { AutomationSettingsValidator } from './settings.js';

const PROJECT_KEY = 'automation_settings_v1';
const SHARED_KEY = 'automation_base_team_v1';
interface PublishedTeam { revision: number; team: BaseTeam | null; }
type StoredProject = AutomationSettings & { inheritedFrom?: BaseTeam };

// Members are matched by persistent ID. Project-only fields win while unedited fields follow the base.
const memberKeys = new Map([['agents','id'], ['connections','id'], ['skillBindings','skillId'], ['mcpServers','name']]);
function mergeValue(key: string, before: unknown, local: unknown, current: unknown): unknown {
  if (equal(local, before)) return current;
  if (equal(current, before) || equal(current, local)) return local;
  const memberKey = memberKeys.get(key);
  if (memberKey) {
    type Member = Record<string, unknown>;
    const members = (value: unknown) => new Map<string, Member>(((value ?? []) as Member[]).map(item => [String(item[memberKey]), item]));
    const old = members(before), project = members(local), base = members(current);
    const reordered = !equal([...project.keys()].filter(id => old.has(id)), [...old.keys()].filter(id => project.has(id)));
    const ids = new Set(reordered ? [...project.keys(), ...base.keys()] : [...base.keys(), ...project.keys()]);
    return [...ids].flatMap(id => {
      const value = mergeValue('', old.get(id), project.get(id), base.get(id));
      return value === undefined ? [] : [value];
    });
  }
  if (key === 'roles' && Array.isArray(before) && Array.isArray(local) && Array.isArray(current)) {
    return [...new Set([...current.filter(role => !before.includes(role) || local.includes(role)), ...local.filter(role => !before.includes(role))])];
  }
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (record(before) && record(local) && record(current)) {
    const keys = new Set([...Object.keys(local), ...Object.keys(current), ...Object.keys(before)]);
    const result: [string, unknown][] = [];
    for (const field of keys) {
      const merged = mergeValue(field, before[field], local[field], current[field]);
      if (merged !== undefined) result.push([field, merged]);
    }
    return Object.fromEntries(result);
  }
  return local;
}

// Strip undefined optional fields just as SQLite's JSON representation does.
function snapshot(settings: BaseTeam): BaseTeam { return JSON.parse(JSON.stringify(teamFrom(settings))); }

export class ProjectTeamSettings {
  constructor(private readonly project: MetaRepository, private readonly shared: () => {db: SqlDatabase; repos: Repositories}) {}

  private published(): PublishedTeam {
    return JSON.parse(this.shared().repos.meta.get(SHARED_KEY) ?? 'null') ?? { revision: 0, team: null };
  }
  private checkRevision(base: PublishedTeam, revision: unknown): void {
    if (revision !== base.revision) throw new TrackerError('CONFLICT', 'Базовая команда изменилась. Откройте настройки заново.');
  }
  public publish(settings: AutomationSettings, revision: unknown): PublishedTeam {
    const store = this.shared();
    return store.db.transaction(() => {
      const base = this.published();
      this.checkRevision(base, revision);
      const team = snapshot(settings);
      if (!team.agents.length) throw new TrackerError('VALIDATION_FAILED', 'Добавьте хотя бы одного агента в базовую команду.');
      if (equal(base.team, team)) return base;
      const updated = {revision: base.revision + 1, team};
      store.repos.meta.set(SHARED_KEY, JSON.stringify(updated));
      return updated;
    });
  }
  public read(): {settings: AutomationSettings; base: BaseTeamState} {
    const published = this.published();
    const raw = this.project.get(PROJECT_KEY);
    const { inheritedFrom, ...saved } = JSON.parse(raw ?? '{}') as Partial<StoredProject>;
    const settings = {...structuredClone(DEFAULT_AUTOMATION_SETTINGS), ...saved};
    const result = (mode: BaseTeamState['mode'], value = settings) => ({base:{...published, mode}, settings:value});
    if (!published.team || (raw && !inheritedFrom)) return result('independent');
    if (!inheritedFrom || equal(inheritedFrom, snapshot(settings))) return result('inherited', applyTeam(settings, published.team));
    const merged = mergeValue('', inheritedFrom, snapshot(settings), published.team) as BaseTeam;
    try {
      return result('custom', new AutomationSettingsValidator().validate(applyTeam(settings, merged)));
    } catch (error) {
      // E.g. the base removed a connection that a project-only profile still uses.
      if (!(error instanceof TrackerError)) throw error;
      return result('conflict');
    }
  }
  public save(settings: AutomationSettings, revision?: unknown, adopt = false): void {
    const base = this.published();
    if (revision !== undefined) this.checkRevision(base, revision);
    const raw = this.project.get(PROJECT_KEY);
    const linked = !raw || !!(JSON.parse(raw) as StoredProject).inheritedFrom;
    const inherit = base.team && (linked || adopt);
    this.project.set(PROJECT_KEY, JSON.stringify({...settings, ...(inherit ? {inheritedFrom:base.team} : {})}));
  }
}
