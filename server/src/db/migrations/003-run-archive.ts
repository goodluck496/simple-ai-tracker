export const version = 3;
export const name = 'run_archive';
export const sql = String.raw`
CREATE TABLE archived_agent_runs (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  archived_at TEXT NOT NULL
);
`;
