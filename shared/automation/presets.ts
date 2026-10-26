import { AgentRole, ProviderKind, RunnerId, type ModelConnection } from './contracts.js';
export const ROLE_OPTIONS = [
  { label: 'Аналитик — план', value: AgentRole.Analyst }, { label: 'Разработчик — код', value: AgentRole.Developer },
  { label: 'Тестировщик — проверки', value: AgentRole.Tester }, { label: 'Ревьюер — оценка кода', value: AgentRole.Reviewer },
  { label: 'Дизайнер — интерфейс', value: AgentRole.Designer }, { label: 'Визуальный валидатор — скриншоты', value: AgentRole.VisualValidator },
];
export const STANDARD_TEAM_ROLES = [AgentRole.Analyst, AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer] as const;
export const ConnectionPreset = { Codex: 'codex', DeepSeek: 'deepseek-api', DeepSeekHarness: 'deepseek-harness', Ollama: 'ollama' } as const;
export type ConnectionPreset = typeof ConnectionPreset[keyof typeof ConnectionPreset];
export const CONNECTION_PRESETS: readonly { id: ConnectionPreset; label: string; runner: RunnerId; connection: Omit<ModelConnection, 'id'> }[] = [
  { id: ConnectionPreset.Codex, label: 'Codex CLI', runner: RunnerId.Codex, connection: { label: 'Codex CLI', kind: ProviderKind.Native, supportsImages: false } },
  { id: ConnectionPreset.DeepSeek, label: 'DeepSeek API', runner: RunnerId.ModelApi, connection: { label: 'DeepSeek API', kind: ProviderKind.OpenAICompatible, baseUrl: 'https://api.deepseek.com', credentialEnv: 'DEEPSEEK_API_KEY', supportsImages: false } },
  { id: ConnectionPreset.DeepSeekHarness, label: 'DeepSeek Harness', runner: RunnerId.DeepSeekHarness, connection: { label: 'DeepSeek Harness', kind: ProviderKind.Native, supportsImages: false } },
  { id: ConnectionPreset.Ollama, label: 'Ollama', runner: RunnerId.ModelApi, connection: { label: 'Ollama', kind: ProviderKind.Ollama, baseUrl: 'http://localhost:11434', supportsImages: false } },
];
export const PROVIDER_OPTIONS = [
  { label: 'Установленный CLI (Codex, Claude, OpenCode…)', value: ProviderKind.Native },
  { label: 'Совместимый API (DeepSeek и другие)', value: ProviderKind.OpenAICompatible },
  { label: 'Ollama — локальные модели', value: ProviderKind.Ollama },
];
