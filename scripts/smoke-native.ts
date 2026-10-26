import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeAgentRunner } from '../server/src/automation/runners/native-runner.js';
import { ProcessExecutor } from '../server/src/automation/runners/process-executor.js';
import { DEFAULT_AUTOMATION_SETTINGS, RUNNER_IDS, type RunnerId } from '../shared/automation/contracts.js';

const runner = process.argv[2] as RunnerId;
const model = process.argv[3];
if (!RUNNER_IDS.includes(runner) || ['model-api', 'custom', 'deepseek-harness'].includes(runner) || !model) throw new Error('Usage: npx tsx scripts/smoke-native.ts <codex|claude-code|opencode|antigravity> <model>');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-native-smoke-'));
const signal = AbortSignal.timeout(120000);
try {
  await new ProcessExecutor().run({ command: 'git', args: ['init'], cwd, signal });
  const response = await new NativeAgentRunner(runner).run({ runId: 'smoke', cwd, signal,
    prompt: 'Do not use tools or change files. Return exactly this JSON: {"verdict":"pass","summary":"tracker-native-smoke-42"}',
    profile: { id: 'smoke', role: 'reviewer', runner, connectionId: 'native', model, instructions: '' },
    connection: { id: 'native', label: 'Native', kind: 'native', supportsImages: false }, settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS) }, () => undefined);
  const result = JSON.parse(response.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  assert.equal(result.verdict, 'pass'); assert.equal(result.summary, 'tracker-native-smoke-42');
  console.log(`PASS: real ${runner} ${model}, non-interactive invocation and native response parser.`);
} finally { await rm(cwd, { recursive: true, force: true }); }
