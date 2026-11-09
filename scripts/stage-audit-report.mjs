import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const [directory = process.env.SAT_STAGE_AUDIT_DIR, taskFilter] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node scripts/stage-audit-report.mjs <directory> [task-id]');

const tasks = new Map();
for (const name of (await readdir(directory)).sort()) {
  if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
  const attempt = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
  if (taskFilter && attempt.taskId !== taskFilter) continue;
  try {
    attempt.audit = JSON.parse(await readFile(path.join(directory, name.replace(/\.json$/, '.audit.json')), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = JSON.stringify([attempt.workspace, attempt.taskId]);
  if (!tasks.has(key)) tasks.set(key, { workspace: attempt.workspace, taskId: attempt.taskId, stages: [] });
  tasks.get(key).stages.push(attempt);
}
for (const task of tasks.values()) {
  task.stages.sort((a, b) => a.at.localeCompare(b.at));
  const sum = read => task.stages.reduce((total, stage) => total + read(stage), 0);
  task.totals = {
    attempts: task.stages.length,
    agentMs: sum(stage => stage.evidence.elapsedMs),
    requests: sum(stage => stage.evidence.requests),
    requestsWithUsage: sum(stage => stage.evidence.usage?.reportedRequests ?? 0),
    observedInputTokens: sum(stage => stage.evidence.usage?.inputTokens ?? 0),
    observedOutputTokens: sum(stage => stage.evidence.usage?.outputTokens ?? 0),
    repeatedReads: sum(stage => stage.evidence.tools.read_file?.repeated ?? 0),
    repeatedChecks: sum(stage => stage.evidence.tools.run_check?.repeated ?? 0),
    auditsCompleted: sum(stage => Number(Array.isArray(stage.audit?.findings))),
    auditsFailed: sum(stage => Number(stage.audit?.failed === true)),
    auditMs: sum(stage => stage.audit?.elapsedMs ?? 0),
  };
}
console.log(JSON.stringify([...tasks.values()], null, 2));
