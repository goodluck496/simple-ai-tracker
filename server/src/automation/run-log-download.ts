import type { ServerResponse } from 'node:http';
import type { AutomationService } from './automation-service.js';

/** Stream persisted raw events in bounded batches, scoped to the service captured by the request. */
export class RunLogDownload {
  public constructor(private readonly service: AutomationService) {}
  public async send(id: string, response: ServerResponse): Promise<void> {
    let events = this.service.logPage(id);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename="execution-log.jsonl"', 'Cache-Control': 'no-store' });
    while (events.length && !response.destroyed) {
      for (const event of events) {
        if (response.destroyed) return;
        if (!response.write(`${JSON.stringify(event)}\n`)) await new Promise<void>((resolve) => {
          const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
          response.once('drain', done); response.once('close', done);
        });
      }
      events = this.service.logPage(id, events.at(-1)!.id);
    }
    response.end();
  }
}
