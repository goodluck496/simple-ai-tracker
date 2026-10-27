import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

interface Owner { key: string; nonce: string; pid: number; host: string; capacity: number; children: string; }
export interface RuntimeLease { release(): void; child(pid: number, running: boolean): void; }

/** Host-local coordination, separate from tracker data. Transactions fence stale-owner recovery. */
export class RuntimeCoordinator {
  private readonly db: DatabaseSync;
  public constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (lstatSync(path.dirname(file)).isSymbolicLink() || (existsSync(file) && lstatSync(file).isSymbolicLink())) throw new Error('Runtime coordinator path is redirected.');
    this.db = new DatabaseSync(path.join(realpathSync(path.dirname(file)), path.basename(file)));
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owners (key TEXT PRIMARY KEY, nonce TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, capacity INTEGER NOT NULL, children TEXT NOT NULL)');
  }
  public close(): void { this.db.close(); }
  public held(prefix: string): boolean {
    return (this.db.prepare('SELECT key FROM owners').all() as unknown as { key: string }[]).some(row => row.key.startsWith(prefix));
  }
  public async acquire(key: string, signal: AbortSignal, capacity = 0): Promise<RuntimeLease> {
    for (;;) {
      signal.throwIfAborted();
      const lease = this.tryAcquire(key, capacity);
      if (lease) return lease;
      await delay(100, undefined, { signal });
    }
  }
  public tryAcquire(key: string, capacity = 0): RuntimeLease | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    const nonce = randomUUID();
    try {
      const rows = this.db.prepare('SELECT * FROM owners').all() as unknown as Owner[];
      for (const row of rows) {
        if (row.host === os.hostname() && !RuntimeCoordinator.alive(row.pid)
          && !(JSON.parse(row.children) as number[]).some(RuntimeCoordinator.alive)) {
          this.db.prepare('DELETE FROM owners WHERE key=? AND nonce=?').run(row.key, row.nonce);
        }
      }
      const existing = this.db.prepare('SELECT * FROM owners').all() as unknown as Owner[];
      const slots = existing.filter(row => row.capacity > 0);
      const limit = Math.min(capacity, ...slots.map(row => row.capacity));
      if (existing.some(row => row.key === key) || (capacity > 0 && slots.length >= limit)) {
        this.db.exec('COMMIT'); return undefined;
      }
      this.db.prepare('INSERT INTO owners VALUES (?,?,?,?,?,?)').run(key, nonce, process.pid, os.hostname(), capacity, '[]');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const children = new Set<number>();
    return {
      release: () => { this.db.prepare('DELETE FROM owners WHERE key=? AND nonce=?').run(key, nonce); },
      child: (pid, running) => {
        if (running) children.add(pid); else children.delete(pid);
        this.db.prepare('UPDATE owners SET children=? WHERE key=? AND nonce=?').run(JSON.stringify([...children]), key, nonce);
      },
    };
  }
  private static alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
      }
      return true;
    } catch (error) { return !['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''); }
  }
}
