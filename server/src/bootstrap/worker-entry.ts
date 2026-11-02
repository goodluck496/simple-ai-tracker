import { WorkerApplication } from '../automation/worker/worker-application.js';

try {
  await new WorkerApplication().run();
} catch (err: any) {
  process.stderr.write(`FATAL WORKER ERROR: ${err?.stack || err}\n`);
  process.exit(1);
}
