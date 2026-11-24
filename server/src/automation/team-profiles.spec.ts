import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRole, DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES, FULL_TEAM_ROLES } from '../../../shared/automation/presets.js';
import { AgentTeamProfiles, customRoleInstructions, DEFAULT_ROLE_INSTRUCTIONS } from '../../../shared/automation/team-profiles.js';

test('standard preset uses one developer and the expanded team keeps optional roles available', () => {
  const profiles = new AgentTeamProfiles();
  assert.deepEqual(STANDARD_TEAM_ROLES, [AgentRole.Developer]);
  assert.deepEqual(FULL_TEAM_ROLES, [AgentRole.Analyst, AgentRole.PlanReviewer, AgentRole.Developer, AgentRole.Reviewer]);
  const team = FULL_TEAM_ROLES.map((role) => profiles.create(role, 'connection'));
  assert.equal(new Set(team.map((agent) => agent.id)).size, FULL_TEAM_ROLES.length);
  assert.deepEqual(team.map((agent) => agent.role), FULL_TEAM_ROLES);
  for (const role of Object.values(AgentRole)) assert.ok(DEFAULT_ROLE_INSTRUCTIONS[role].length > 100);
  assert.equal(new Set(team.map((agent) => agent.instructions)).size, FULL_TEAM_ROLES.length);
});

test('role changes update basic instructions but retain custom text', () => {
  const profiles = new AgentTeamProfiles();
  const agent = profiles.create(AgentRole.Developer, 'connection');
  profiles.changeRole(agent, AgentRole.Reviewer);
  assert.equal(agent.instructions, DEFAULT_ROLE_INSTRUCTIONS[AgentRole.Reviewer]);
  agent.instructions = 'Особые правила проекта';
  profiles.changeRole(agent, AgentRole.Tester);
  assert.equal(agent.instructions, 'Особые правила проекта');
  agent.instructions = ' ';
  profiles.changeRole(agent, AgentRole.Analyst);
  assert.equal(agent.instructions, DEFAULT_ROLE_INSTRUCTIONS[AgentRole.Analyst]);
});

test('built-in instructions are not repeated in a saved project profile', () => {
  const legacy = 'Оцени сложность, риск и неопределённость задачи. Подготовь критерии приёмки и предложи разрешённые профили для следующих этапов. Не меняй код и лимиты.';
  const custom = 'Используй обязательные критерии из карточки.';
  for (const defaults of [legacy, DEFAULT_ROLE_INSTRUCTIONS[AgentRole.Router]]) {
    assert.equal(customRoleInstructions(AgentRole.Router, defaults), '');
    assert.equal(customRoleInstructions(AgentRole.Router, `${defaults}\n\n${custom}`), custom);
  }
  assert.equal(customRoleInstructions(AgentRole.Router, custom), custom);
});

test('legacy duplicate IDs repair in a draft while models, instructions, order and intentional repeats survive', () => {
  const legacyRoles = [AgentRole.Analyst, AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer];
  let next = 0; const profiles = new AgentTeamProfiles(() => `repair-${++next}`);
  const input = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS),
    agents: legacyRoles.map((role) => ({ ...profiles.create(role, 'connection'), id: 'agent-123', model: role, instructions: role === AgentRole.Reviewer ? 'Keep this custom review' : '' })),
    pipeline: ['agent-123', 'agent-123', 'agent-123', 'agent-123'],
  };
  const { settings, repaired } = profiles.prepare(input);
  assert.equal(repaired, true); assert.equal(new Set(settings.agents.map((agent) => agent.id)).size, 4);
  assert.deepEqual(settings.pipeline.map((id) => settings.agents.find((agent) => agent.id === id)!.role), legacyRoles);
  assert.deepEqual(settings.agents.map((agent) => agent.model), legacyRoles);
  assert.equal(settings.agents[3].instructions, 'Keep this custom review');
  assert.equal(new Set(input.agents.map((agent) => agent.id)).size, 1, 'Original settings are not mutated or persisted');
  assert.equal(input.agents[0].instructions, '');
  settings.pipeline = [settings.agents[1].id, settings.agents[1].id];
  const prepared = profiles.prepare(settings);
  assert.equal(prepared.repaired, false); assert.deepEqual(prepared.settings.pipeline, settings.pipeline);
});
