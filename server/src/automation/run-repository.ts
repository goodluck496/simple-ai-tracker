import { RunStatus, ACTIVE_RUN_STATUSES, AUTOMATION_LIMITS, type AgentRun, type RunEvent } from '../../../shared/automation/contracts.js';
import type { SqlDatabase } from '../db/sql-database.js';
import { QUEUE_LIMITS } from '../../../shared/automation/queue.js';

export class AgentRunRepository {
  public constructor(public readonly db: SqlDatabase) {}
  public list(taskId?: string): AgentRun[] {
    const rows = taskId ? this.db.prepare('SELECT payload FROM agent_runs WHERE task_id = ? AND id NOT IN (SELECT run_id FROM archived_agent_runs) ORDER BY updated_at DESC LIMIT 100').all<{ payload: string }>([taskId])
      : this.db.prepare('SELECT payload FROM agent_runs WHERE id NOT IN (SELECT run_id FROM archived_agent_runs) ORDER BY updated_at DESC LIMIT 100').all<{ payload: string }>();
    return rows.map(({ payload }) => JSON.parse(payload) as AgentRun);
  }
  public get(id: string): AgentRun | undefined {
    const row = this.db.prepare('SELECT payload FROM agent_runs WHERE id = ?').get<{ payload: string }>([id]);
    return row ? JSON.parse(row.payload) as AgentRun : undefined;
  }
  public history(taskId?: string): AgentRun[] {
    const rows = taskId
      ? this.db.prepare('SELECT payload FROM agent_runs WHERE task_id=? ORDER BY updated_at DESC, id ASC LIMIT 200').all<{ payload: string }>([taskId])
      : this.db.prepare('SELECT payload FROM agent_runs ORDER BY updated_at DESC, id ASC LIMIT 200').all<{ payload: string }>();
    return rows.map(row => JSON.parse(row.payload) as AgentRun);
  }
  public delete(id: string): void {
    this.db.prepare('DELETE FROM agent_run_events WHERE run_id=?').run([id]);
    this.db.prepare('DELETE FROM archived_agent_runs WHERE run_id=?').run([id]);
    this.db.prepare('DELETE FROM agent_runs WHERE id=?').run([id]);
  }
  public queue(): AgentRun[] {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(',');
    return this.db.prepare(`SELECT payload FROM agent_runs WHERE status IN (${placeholders}) OR id IN
      (SELECT id FROM agent_runs WHERE status NOT IN (${placeholders}) AND id NOT IN (SELECT run_id FROM archived_agent_runs) ORDER BY updated_at DESC LIMIT ?)
      AND id NOT IN (SELECT run_id FROM archived_agent_runs)
      ORDER BY updated_at DESC`).all<{ payload: string }>([...ACTIVE_RUN_STATUSES, ...ACTIVE_RUN_STATUSES, QUEUE_LIMITS.recent]).map(({ payload }) => JSON.parse(payload) as AgentRun);
  }
  public archived(): AgentRun[] {
    return this.db.prepare('SELECT r.payload FROM agent_runs r JOIN archived_agent_runs a ON a.run_id = r.id ORDER BY a.archived_at DESC').all<{ payload: string }>().map(({ payload }) => JSON.parse(payload) as AgentRun);
  }
  public archive(id: string, at: string): void { this.db.prepare('INSERT INTO archived_agent_runs(run_id, archived_at) VALUES(?, ?) ON CONFLICT(run_id) DO NOTHING').run([id, at]); }
  public restore(id: string): void { this.db.prepare('DELETE FROM archived_agent_runs WHERE run_id = ?').run([id]); }
  public running(): AgentRun[] {
    return this.db.prepare('SELECT payload FROM agent_runs WHERE status IN (?,?)').all<{ payload: string }>([RunStatus.Running, RunStatus.Integrating]).map(({ payload }) => JSON.parse(payload) as AgentRun);
  }
  public nextQueued(): AgentRun | undefined {
    const row = this.db.prepare('SELECT payload FROM agent_runs WHERE status = ? ORDER BY updated_at ASC, id ASC LIMIT 1').get<{ payload: string }>([RunStatus.Queued]);
    return row ? JSON.parse(row.payload) as AgentRun : undefined;
  }
  public hasActive(taskId: string): boolean {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(',');
    return !!this.db.prepare(`SELECT id FROM agent_runs WHERE task_id = ? AND status IN (${placeholders}) LIMIT 1`).get([taskId, ...ACTIVE_RUN_STATUSES]);
  }
  public activeTaskIds(): string[] {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(',');
    return this.db.prepare(`SELECT DISTINCT task_id FROM agent_runs WHERE status IN (${placeholders})`).all<{ task_id: string }>([...ACTIVE_RUN_STATUSES]).map((row) => row.task_id);
  }
  public save(run: AgentRun): void {
    this.db.prepare('INSERT INTO agent_runs(id, task_id, status, payload, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at')
      .run([run.id, run.taskId, run.status, JSON.stringify(run), run.updatedAt]);
  }
  public event(runId: string, kind: string, text: string, at: string): void {
    const insert = this.db.prepare('INSERT INTO agent_run_events(run_id, at, kind, text) VALUES(?,?,?,?)');
    if (kind !== 'progress') { insert.run([runId, at, kind, text.slice(0, AUTOMATION_LIMITS.eventTextLength)]); return; }
    for (let offset = 0; offset < text.length; offset += AUTOMATION_LIMITS.eventTextLength) {
      insert.run([runId, at, kind, text.slice(offset, offset + AUTOMATION_LIMITS.eventTextLength)]);
    }
  }
  public eventPage(runId: string, after: number): RunEvent[] {
    return this.db.prepare('SELECT id, run_id AS runId, at, kind, text FROM agent_run_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 200')
      .all<RunEvent>([runId, after]);
  }
  public events(runId: string): RunEvent[] {
    return this.db.prepare('SELECT id, run_id AS runId, at, kind, text FROM agent_run_events WHERE run_id = ? ORDER BY id DESC LIMIT 200')
      .all<RunEvent>([runId]).reverse();
  }
}
