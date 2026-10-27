import { setTimeout as delay } from 'node:timers/promises';
import { AUTOMATION_TIMING } from '../../../../shared/automation/contracts.js';

interface Lane { tick(): Promise<boolean>; stop(): void; }
export class WorkerPool {
  private readonly controller = new AbortController();
  public constructor(private readonly lanes: Lane[]) {}
  public stop(): void { this.controller.abort(); for (const lane of this.lanes) lane.stop(); }
  public async run(once = false): Promise<void> {
    const active = this.lanes.map(async lane => {
      while (!this.controller.signal.aborted) {
        const worked = await lane.tick();
        if (once) return;
        if (!worked && !this.controller.signal.aborted) {
          try { await delay(AUTOMATION_TIMING.pollMs, undefined, { signal: this.controller.signal }); }
          catch (error) { if (!this.controller.signal.aborted) throw error; }
        }
      }
    });
    try { await Promise.all(active); }
    catch (error) { this.stop(); await Promise.allSettled(active); throw error; }
  }
}
