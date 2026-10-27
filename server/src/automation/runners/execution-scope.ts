import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExecutionContext { child?(pid: number, running: boolean): void; env?: NodeJS.ProcessEnv; }
/** A separate scope per parallel run; never mutate the worker's process.env. */
export class ExecutionScope {
  private static readonly context = new AsyncLocalStorage<ExecutionContext>();
  public static run<T>(context: ExecutionContext, callback: () => T): T { return this.context.run(context, callback); }
  public static get current(): ExecutionContext | undefined { return this.context.getStore(); }
}
