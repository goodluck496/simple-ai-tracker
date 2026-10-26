import type { ModelConnection, RunnerId } from './contracts.js';

export interface ModelCatalogInput { connection: ModelConnection; runner: RunnerId; }
export interface ModelOption { id: string; label: string; }
export const MODEL_CATALOG_LIMITS = { timeoutMs: 20000, maxModels: 1000, maxBytes: 2 * 1024 * 1024, textLength: 300 } as const;

/** Key includes the draft connection, so an edited endpoint never reuses an old catalog. */
export class ModelCatalogKey {
  public static create(input: ModelCatalogInput): string { return JSON.stringify([input.runner, input.connection]); }
}
