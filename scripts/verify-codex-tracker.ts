import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContainer } from '../server/src/bootstrap/container.js';
import { SilentLogger } from '../server/src/core/logger.js';
import { NativeAgentRunner } from '../server/src/automation/runners/native-runner.js';
import { ProcessExecutor } from '../server/src/automation/runners/process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';
import { AGENT_TRACKER_SERVER } from '../shared/automation/tracker-access.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'sat-codex-mcp-'));
const dbPath = path.join(root, 'data', 'tracker.db');
const app = createContainer({ config: { appRoot: root, dbPath }, logger: new SilentLogger() });
const expected = `fixture-read-${crypto.randomUUID()}`;
const task = app.taskService.createTask({ title: expected }); app.close();
const signal = AbortSignal.timeout(120000);
try {
  await new ProcessExecutor().run({ command: 'git', args: ['init'], cwd: root, signal });
  await writeFile(path.join(root, 'AGENTS.md'), 'Read task data only through MCP tracker_get_task. Do not edit files or use shell commands to access tasks.', 'utf8');
  const prefix = `mcp_servers.${AGENT_TRACKER_SERVER}`;
  const config = [`${prefix}.command=${JSON.stringify(process.execPath)}`,
    `${prefix}.args=${JSON.stringify([path.resolve(import.meta.dirname, '../dist/server/mcp.mjs')])}`,
    `${prefix}.env.SAT_HOME=${JSON.stringify(root)}`, `${prefix}.env.SAT_DB_PATH=${JSON.stringify(dbPath)}`,
    `${prefix}.env.SAT_BACKUP_ENABLED="false"`, `${prefix}.env.SAT_WORKSPACE="default"`, 'approval_policy="never"'];
  let progress = '';
  const result = await new NativeAgentRunner('codex').run({ runId: 'fixture', cwd: root, signal,
    prompt: `Call tracker_get_task for ${task.id} with explicit workspace default. You must actually call this MCP tool. Return ONLY JSON {"verdict":"pass","summary":"the exact task title returned by MCP"}. Do not guess, edit files or use other tools.`,
    profile: { id: 'fixture', role: 'analyst', runner: 'codex', connectionId: 'native', model: process.argv[2] ?? 'gpt-6-luna', instructions: '', args: config.flatMap((entry) => ['-c', entry]) },
    connection: { id: 'native', label: 'Codex', kind: 'native', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS),
  }, (text) => { progress += text; });
  assert.ok(progress.includes('tracker_get_task'), 'Must actually call the tracker');
  const outcome = JSON.parse(result.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  assert.equal(outcome.verdict, 'pass'); assert.equal(outcome.summary, expected);
  assert.equal(progress.includes('requires approval, but approval policy is never'), false);
  console.log('PASS: real Codex reads a temporary tracker task via read-only MCP under approval_policy=never; no live tasks accessed.');
} finally { await rm(root, { recursive: true, force: true }); }
