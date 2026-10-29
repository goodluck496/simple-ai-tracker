import { AgentRole, ProviderKind, RunnerId, type ModelConnection } from './contracts.js';
export const ROLE_OPTIONS = [
  { label: 'Аналитик — план', value: AgentRole.Analyst }, { label: 'Разработчик — анализ, код, юнит-тесты', value: AgentRole.Developer },
  { label: 'Тестировщик — ревью и проверки', value: AgentRole.Tester }, { label: 'Ревьюер — оценка кода', value: AgentRole.Reviewer },
  { label: 'Дизайнер — интерфейс', value: AgentRole.Designer }, { label: 'Визуальный валидатор — скриншоты', value: AgentRole.VisualValidator },
];
export const STANDARD_TEAM_ROLES = [AgentRole.Developer, AgentRole.Tester] as const;
export const FULL_TEAM_ROLES = [AgentRole.Analyst, AgentRole.Developer, AgentRole.Tester, AgentRole.Reviewer] as const;
export const ConnectionPreset = { Codex: 'codex', Claude: 'claude-code', OpenCode: 'opencode', Antigravity: 'antigravity', DeepSeek: 'deepseek-api', DeepSeekHarness: 'deepseek-harness', Ollama: 'ollama', OpenAI: 'openai-compatible', Custom: 'custom' } as const;
export type ConnectionPreset = typeof ConnectionPreset[keyof typeof ConnectionPreset];
export const CONNECTION_PRESETS: readonly { id: ConnectionPreset; label: string; runner: RunnerId; connection: Omit<ModelConnection, 'id'> }[] = [
  { id: ConnectionPreset.Codex, label: 'Codex CLI', runner: RunnerId.Codex, connection: { label: 'Codex CLI', kind: ProviderKind.Native, nativeRunner: RunnerId.Codex, supportsImages: false } },
  { id: ConnectionPreset.Claude, label: 'Claude Code', runner: RunnerId.ClaudeCode, connection: { label: 'Claude Code', kind: ProviderKind.Native, nativeRunner: RunnerId.ClaudeCode, supportsImages: false } },
  { id: ConnectionPreset.OpenCode, label: 'OpenCode', runner: RunnerId.OpenCode, connection: { label: 'OpenCode', kind: ProviderKind.Native, nativeRunner: RunnerId.OpenCode, supportsImages: false } },
  { id: ConnectionPreset.Antigravity, label: 'Antigravity', runner: RunnerId.Antigravity, connection: { label: 'Antigravity', kind: ProviderKind.Native, nativeRunner: RunnerId.Antigravity, supportsImages: false } },
  { id: ConnectionPreset.DeepSeek, label: 'DeepSeek API', runner: RunnerId.ModelApi, connection: { label: 'DeepSeek API', kind: ProviderKind.OpenAICompatible, baseUrl: 'https://api.deepseek.com', credentialEnv: 'DEEPSEEK_API_KEY', supportsImages: false } },
  { id: ConnectionPreset.DeepSeekHarness, label: 'DeepSeek Harness', runner: RunnerId.DeepSeekHarness, connection: { label: 'DeepSeek Harness', kind: ProviderKind.Native, nativeRunner: RunnerId.DeepSeekHarness, supportsImages: false } },
  { id: ConnectionPreset.Ollama, label: 'Ollama', runner: RunnerId.ModelApi, connection: { label: 'Ollama', kind: ProviderKind.Ollama, baseUrl: 'http://localhost:11434', supportsImages: false } },
  { id: ConnectionPreset.OpenAI, label: 'OpenAI-compatible API', runner: RunnerId.ModelApi, connection: { label: 'OpenAI-compatible API', kind: ProviderKind.OpenAICompatible, baseUrl: 'https://api.openai.com/v1', credentialEnv: 'OPENAI_API_KEY', supportsImages: false } },
  { id: ConnectionPreset.Custom, label: 'Свой CLI / bridge', runner: RunnerId.Custom, connection: { label: 'Свой CLI / bridge', kind: ProviderKind.Native, nativeRunner: RunnerId.Custom, supportsImages: false } },
];
export const RUNNER_OPTIONS = [
  { label: 'Codex CLI', value: RunnerId.Codex }, { label: 'Claude Code', value: RunnerId.ClaudeCode },
  { label: 'OpenCode', value: RunnerId.OpenCode }, { label: 'Antigravity', value: RunnerId.Antigravity },
  { label: 'DeepSeek Harness', value: RunnerId.DeepSeekHarness }, { label: 'API (Ollama / DeepSeek / совместимый)', value: RunnerId.ModelApi },
  { label: 'Свой CLI / bridge', value: RunnerId.Custom },
];
export const PROVIDER_OPTIONS = [
  { label: 'Установленный CLI (Codex, Claude, OpenCode…)', value: ProviderKind.Native },
  { label: 'Совместимый API (DeepSeek и другие)', value: ProviderKind.OpenAICompatible },
  { label: 'Ollama — локальные модели', value: ProviderKind.Ollama },
];
