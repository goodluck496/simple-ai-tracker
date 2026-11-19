export const version = 5;
export const name = 'automation_improvements';
export const sql = String.raw`
CREATE INDEX idx_agent_runs_started ON agent_runs(json_extract(payload, '$.startedAt'));
CREATE TABLE automation_check_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_automation_checks_run ON automation_check_executions(run_id);
CREATE TABLE automation_check_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  lease_hash TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE automation_occurrences (
  event_id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  cause_key TEXT,
  improvement_task_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX idx_automation_occurrences_run ON automation_occurrences(run_id, event_id);
CREATE INDEX idx_automation_occurrences_task ON automation_occurrences(task_id);
CREATE INDEX idx_automation_occurrences_at ON automation_occurrences(at);
CREATE TABLE automation_improvement_cases (
  cause_key TEXT PRIMARY KEY,
  improvement_task_id TEXT NOT NULL
);
`;
