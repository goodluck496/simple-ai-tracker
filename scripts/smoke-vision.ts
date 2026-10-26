import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { ModelApiRunner } from '../server/src/automation/runners/model-api-runner.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../shared/automation/contracts.js';

const model = process.argv[2];
if (!model) throw new Error('Usage: npx tsx scripts/smoke-vision.ts <installed-vision-model>');
const cwd = await mkdtemp(path.join(os.tmpdir(), 'sat-real-vision-'));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 500, height: 240 } });
  await page.setContent('<body style="background:white;display:grid;place-items:center;height:200px"><div style="background:#16803d;color:white;padding:30px;font:36px Arial">VALIDATED</div></body>');
  await page.screenshot({ path: path.join(cwd, 'screen.png') });
  const response = await new ModelApiRunner().run({ runId: 'vision-smoke', cwd, signal: AbortSignal.timeout(180000),
    prompt: 'Inspect the supplied screenshot. Return ONLY JSON with verdict pass and summary containing the exact word visible on the green rectangle. Do not infer it from filenames.',
    profile: { id: 'vision', role: 'visual-validator', runner: 'model-api', connectionId: 'local', model, instructions: '' },
    connection: { id: 'local', label: 'Ollama vision', kind: 'ollama', baseUrl: process.env.SAT_OLLAMA_URL ?? 'http://localhost:11434', supportsImages: true },
    settings: { ...structuredClone(DEFAULT_AUTOMATION_SETTINGS), artifactPaths: ['screen.png'] } }, () => undefined);
  const result = JSON.parse(response.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  assert.equal(result.verdict, 'pass'); assert.match(result.summary, /VALIDATED/);
  console.log(`PASS: real vision ${model} identified screenshot text through image input.`);
} finally { await browser.close(); await rm(cwd, { recursive: true, force: true }); }
