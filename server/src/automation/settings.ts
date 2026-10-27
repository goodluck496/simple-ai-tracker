import { AGENT_ROLES, RUNNER_IDS, AgentRole, RunnerId, ProviderKind, PROVIDER_KINDS, REASONING_EFFORTS, MERGE_POLICIES, AUTOMATION_LIMITS, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { TrackerError } from '../core/errors.js';
const PROVIDER_URL_PROTOCOLS = new Set(['http:', 'https:']);

export class AutomationSettingsValidator {
  public validate(input: unknown): AutomationSettings {
    const fail = (message: string): never => { throw new TrackerError('VALIDATION_FAILED', message); };
    if (!input || typeof input !== 'object') return fail('Automation settings must be an object.');
    const settings = input as AutomationSettings;
    const text = (value: unknown) => typeof value === 'string';
    if (!text(settings.repositoryPath) || !text(settings.baseBranch)) return fail('Repository path and base branch are required.');
    if (!/^[a-zA-Z0-9][\w./-]*$/.test(settings.baseBranch) || settings.baseBranch.includes('..')) return fail('Invalid base branch.');
    if (!Array.isArray(settings.connections) || !Array.isArray(settings.agents) || !Array.isArray(settings.pipeline)
      || !Array.isArray(settings.checks) || !Array.isArray(settings.setup) || !Array.isArray(settings.artifactPaths)) return fail('Connections, agents, pipeline, setup, checks and artifacts must be arrays.');
    const ids = new Set<string>();
    for (const connection of settings.connections) {
      if (!connection || !text(connection.id) || !/^[\w-]+$/.test(connection.id) || ids.has(connection.id)) return fail('Connection IDs must be unique.');
      ids.add(connection.id);
      if (!text(connection.label) || !PROVIDER_KINDS.includes(connection.kind)
        || typeof connection.supportsImages !== 'boolean') return fail('Invalid connection.');
      if (connection.credentialEnv && !/^[A-Z_][A-Z0-9_]*$/.test(connection.credentialEnv)) return fail('Credential must be an environment variable name.');
      if (connection.reasoningEffort && !REASONING_EFFORTS.includes(connection.reasoningEffort)) return fail('Invalid reasoning effort.');
      if (Object.keys(connection).some((key) => /apiKey|password|secret|token/i.test(key))) return fail('Store credentials on the worker, not in tracker settings.');
      if (connection.kind !== ProviderKind.Native) {
        try {
          const url = new URL(connection.baseUrl ?? '');
          if (!PROVIDER_URL_PROTOCOLS.has(url.protocol) || url.username || url.password || url.search || url.hash) return fail('Invalid provider URL.');
        } catch { return fail('Provider URL is required.'); }
      }
    }
    const profiles = new Map<string, typeof settings.agents[number]>();
    for (const agent of settings.agents) {
      if (!agent || !text(agent.id) || !/^[\w-]+$/.test(agent.id) || profiles.has(agent.id)) return fail('Agent IDs must be unique.');
      profiles.set(agent.id, agent);
      if (!AGENT_ROLES.includes(agent.role) || !RUNNER_IDS.includes(agent.runner) || !text(agent.instructions)
        || !text(agent.model) || !agent.model.trim() || !ids.has(agent.connectionId)) return fail('Invalid agent profile, model or connection.');
      const connection = settings.connections.find((entry) => entry.id === agent.connectionId)!;
      if (agent.role === AgentRole.VisualValidator && !connection.supportsImages) return fail('Visual validator requires an image-capable connection.');
      if (agent.runner === RunnerId.ModelApi && connection.kind === ProviderKind.Native) return fail('Model API runner requires Ollama or an OpenAI-compatible endpoint.');
      if (agent.runner !== RunnerId.ModelApi && connection.kind !== ProviderKind.Native) return fail('Native runners use their own provider configuration. Use model-api for endpoint connections.');
      if (agent.runner === RunnerId.DeepSeekHarness && !agent.nativeProfile) return fail('DeepSeek Harness requires a worker-side native profile with the selected model.');
      if (agent.runner === RunnerId.Custom && (!text(agent.command) || !agent.command || !Array.isArray(agent.args))) return fail('Custom runner requires an executable and argv.');
      if (agent.args && !agent.args.every(text)) return fail('Runner args must be strings.');
    }
    if (!settings.pipeline.every((id) => text(id) && profiles.has(id))) return fail('Pipeline references an unknown agent.');
    if (!settings.checks.every((check) => check && text(check.command) && check.command && Array.isArray(check.args) && check.args.every(text))) return fail('Invalid check command.');
    if (!settings.setup.every((check) => check && text(check.command) && check.command && Array.isArray(check.args) && check.args.every(text))) return fail('Invalid setup command.');
    if (!settings.artifactPaths.every((entry) => text(entry) && !entry.includes('..') && !/^(?:[a-z]:|[\/\\])/i.test(entry))) return fail('Artifacts must be relative paths inside the worktree.');
    if (!Number.isInteger(settings.timeoutMinutes) || settings.timeoutMinutes < AUTOMATION_LIMITS.timeoutMinutes.min || settings.timeoutMinutes > AUTOMATION_LIMITS.timeoutMinutes.max
      || !Number.isInteger(settings.maxRevisions) || settings.maxRevisions < AUTOMATION_LIMITS.revisions.min || settings.maxRevisions > AUTOMATION_LIMITS.revisions.max) return fail('Invalid run limits.');
    if (!MERGE_POLICIES.includes(settings.mergePolicy)) return fail('Invalid merge policy.');
    const maxAgentCalls = settings.maxAgentCalls ?? 6;
    const maxInputTokens = settings.maxInputTokens ?? 500000;
    const maxRunMinutes = settings.maxRunMinutes ?? 20;
    const execution = { maxParallelRuns: settings.maxParallelRuns ?? 2, dependencyMode: settings.dependencyMode ?? 'isolated',
      maxMergeAttempts: settings.maxMergeAttempts ?? 2, resolveConflicts: settings.resolveConflicts ?? true,
      maxResolverCalls: settings.maxResolverCalls ?? 1, resolverTimeoutMinutes: settings.resolverTimeoutMinutes ?? 3,
      maxResolverToolCalls: settings.maxResolverToolCalls ?? 16 };
    const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
    if (!integer(execution.maxParallelRuns, 1, 8) || !integer(execution.maxMergeAttempts, 1, 3)
      || !integer(execution.maxResolverCalls, 0, 3) || !integer(execution.resolverTimeoutMinutes, 1, 10)
      || !integer(execution.maxResolverToolCalls, 1, 40) || typeof execution.resolveConflicts !== 'boolean'
      || !['isolated', 'linked'].includes(execution.dependencyMode)) return fail('Invalid parallel execution or integration settings.');
    if (!Number.isSafeInteger(maxAgentCalls) || maxAgentCalls < 1 || maxAgentCalls > 100
      || !Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1 || maxInputTokens > 100000000
      || !Number.isSafeInteger(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > 240) return fail('Invalid run budget.');
    // Reconstruct persisted objects so unknown fields cannot carry credentials.
    return {
      repositoryPath: settings.repositoryPath, baseBranch: settings.baseBranch,
      connections: settings.connections.map(({ id, label, kind, baseUrl, credentialEnv, supportsImages, reasoningEffort }) => ({ id, label, kind, baseUrl, credentialEnv, supportsImages, reasoningEffort })),
      agents: settings.agents.map(({ id, role, runner, connectionId, model, instructions, nativeProfile, command, args }) => ({ id, role, runner, connectionId, model, instructions, nativeProfile, command, args })),
      pipeline: settings.pipeline, checks: settings.checks.map(({ command, args }) => ({ command, args })), setup: settings.setup.map(({ command, args }) => ({ command, args })), artifactPaths: settings.artifactPaths,
      timeoutMinutes: settings.timeoutMinutes, maxRevisions: settings.maxRevisions, mergePolicy: settings.mergePolicy,
      maxAgentCalls, maxInputTokens, maxRunMinutes,
      ...execution,
    };
  }
}
