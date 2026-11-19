import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserCheckResult, CheckExecution } from '../../../../shared/automation/improvement-metrics.js';
import { SCREENSHOT_LIMIT } from '../../../../shared/automation/screenshots.js';
import { readStageScreenshots } from './stage-screenshots.js';

export async function runWithBrowserEvidence(cwd: string, execute: (output: string) => Promise<void>): Promise<BrowserCheckResult[]> {
  const output = path.join(cwd, '.sat', 'browser-' + randomUUID() + '.json');
  await execute(output);
  const details: unknown = await fs.stat(output).then(async stat => stat.isFile() && stat.size < 32_768
    ? JSON.parse(await fs.readFile(output, 'utf8')) : undefined).catch(() => undefined);
  if (!Array.isArray(details)) return [];
  const results: BrowserCheckResult[] = [];
  for (const item of details.slice(0, SCREENSHOT_LIMIT)) {
    if (!item || ![item.criterionId, item.action, item.assertion, item.actual, item.screenshot].every(
      value => typeof value === 'string' && value.trim().length && value.length <= 500)) continue;
    const [png] = await readStageScreenshots(cwd, [item.screenshot]).catch(() => []);
    if (!png) continue;
    results.push({ criterionId: item.criterionId, action: item.action, assertion: item.assertion, actual: item.actual,
      screenshot: item.screenshot, imageDigest: createHash('sha256').update(png).digest('hex') });
  }
  return results;
}

export async function readCriterionImages(cwd: string, checks: CheckExecution[]): Promise<string[]> {
  const images = await Promise.all(checks.flatMap(check => check.browserResults ?? [])
    .map(async result => {
      const [png] = await readStageScreenshots(cwd, [result.screenshot]).catch(() => []);
      return png && createHash('sha256').update(png).digest('hex') === result.imageDigest ? png : undefined;
    }));
  return [...new Set(images.filter((image): image is string => !!image))].slice(0, SCREENSHOT_LIMIT);
}
