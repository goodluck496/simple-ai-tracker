import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRole, DEFAULT_AUTOMATION_SETTINGS } from '../../../shared/automation/contracts.js';
import { STANDARD_TEAM_ROLES, FULL_TEAM_ROLES } from '../../../shared/automation/presets.js';
import { AgentTeamProfiles, DEFAULT_ROLE_INSTRUCTIONS } from '../../../shared/automation/team-profiles.js';

test('batch team has unique IDs, distinct roles and usable default instructions', () => {
  const profiles = new AgentTeamProfiles();
  const team = STANDARD_TEAM_ROLES.map((role) => profiles.create(role, 'connection'));
  assert.equal(new Set(team.map((agent) => agent.id)).size, 2);
  assert.deepEqual(team.map((agent) => agent.role), STANDARD_TEAM_ROLES);
  for (const role of Object.values(AgentRole)) assert.ok(DEFAULT_ROLE_INSTRUCTIONS[role].length > 100);
  assert.equal(new Set(team.map((agent) => agent.instructions)).size, 2);
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

test('legacy duplicate IDs repair in a draft while models, instructions, order and intentional repeats survive', () => {
  let next = 0; const profiles = new AgentTeamProfiles(() => `repair-${++next}`);
  const input = { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS),
    agents: FULL_TEAM_ROLES.map((role) => ({ ...profiles.create(role, 'connection'), id: 'agent-123', model: role, instructions: role === AgentRole.Reviewer ? 'Keep this custom review' : '' })),
    pipeline: ['agent-123', 'agent-123', 'agent-123', 'agent-123'],
  };
  const { settings, repaired } = profiles.prepare(input);
  assert.equal(repaired, true); assert.equal(new Set(settings.agents.map((agent) => agent.id)).size, 4);
  assert.deepEqual(settings.pipeline.map((id) => settings.agents.find((agent) => agent.id === id)!.role), FULL_TEAM_ROLES);
  assert.deepEqual(settings.agents.map((agent) => agent.model), FULL_TEAM_ROLES);
  assert.equal(settings.agents[3].instructions, 'Keep this custom review');
  assert.equal(new Set(input.agents.map((agent) => agent.id)).size, 1, 'Original settings are not mutated or persisted');
  assert.equal(input.agents[0].instructions, '');
  settings.pipeline = [settings.agents[1].id, settings.agents[1].id];
  const prepared = profiles.prepare(settings);
  assert.equal(prepared.repaired, false); assert.deepEqual(prepared.settings.pipeline, settings.pipeline);
});
