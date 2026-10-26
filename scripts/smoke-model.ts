import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ModelApiRunner } from '../server/src/automation/runners/model-api-runner.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';

const model = process.argv[2];
if (!model) throw new Error('Usage: npx tsx scripts/smoke-model.ts <installed-ollama-model>');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-real-model-'));
try {
  await writeFile(path.join(cwd, 'source.txt'), 'tracker-fixture-42', 'utf8');
  const response = await new ModelApiRunner().run({ runId: 'smoke', cwd, signal: AbortSignal.timeout(180000),
    prompt: 'Read source.txt with read_file. Return only JSON with verdict pass and summary equal to the file content. Do not run checks or write files.',
    profile: { id: 'smoke', role: 'reviewer', runner: 'model-api', connectionId: 'local', model, instructions: '' },
    connection: { id: 'local', label: 'Local Ollama', kind: 'ollama', baseUrl: process.env.SAT_OLLAMA_URL ?? 'http://localhost:11434', supportsImages: false },
    settings: structuredClone(DEFAULT_AUTOMATION_SETTINGS) }, (message) => process.stderr.write(`${message}\n`));
  const result = JSON.parse(response.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  assert.equal(result.verdict, 'pass');
  assert.ok(result.summary.includes('tracker-fixture-42'));
  console.log(`PASS: real Ollama ${model}, file tool and final JSON verdict.`);
} finally { await rm(cwd, { recursive: true, force: true }); }
