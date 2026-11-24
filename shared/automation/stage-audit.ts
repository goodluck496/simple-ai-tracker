import { ProviderKind, RunnerId, type ModelConnection } from './contracts.js';
import { CONNECTION_PRESETS } from './presets.js';

export function nativeConnectionRunner(connection: ModelConnection): RunnerId {
  return connection.nativeRunner ?? CONNECTION_PRESETS.find(preset =>
    preset.connection.kind === ProviderKind.Native && preset.connection.label === connection.label)?.runner ?? RunnerId.Codex;
}

export function stageAuditRunner(connection: ModelConnection | undefined): RunnerId {
  return connection?.kind === ProviderKind.Native ? nativeConnectionRunner(connection) : RunnerId.ModelApi;
}
