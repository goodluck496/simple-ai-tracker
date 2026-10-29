export const version = 4;
export const name = 'task_execution_trust';
export const sql = String.raw`
ALTER TABLE tasks ADD COLUMN trusted_execution INTEGER NOT NULL DEFAULT 0 CHECK (trusted_execution IN (0, 1));
`;
