export const version = 2;
export const name = 'automation';
export const sql = String.raw`
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs(task_id)
  WHERE status IN ('queued', 'running', 'waiting');
CREATE TABLE agent_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX agent_run_events_run ON agent_run_events(run_id, id);
`;
