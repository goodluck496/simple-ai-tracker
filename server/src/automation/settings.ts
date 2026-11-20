import { AGENT_ROLES, RUNNER_IDS, RunnerId, ProviderKind, PROVIDER_KINDS, REASONING_EFFORTS, MERGE_POLICIES, AUTOMATION_LIMITS, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { TrackerError } from '../core/errors.js';
import { PipelinePolicy } from '../../../shared/automation/pipeline-policy.js';
import { validMcp } from '../../../shared/automation/project-mcp.js';
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
    if (settings.mcpServers !== undefined && (!Array.isArray(settings.mcpServers) || settings.mcpServers.length > 12
      || settings.mcpServers.some(server => !validMcp(server) || !Array.isArray(server.roles) || (server.roles.length > 0 && !server.tools.length))
      || new Set(settings.mcpServers.map(server => server.name)).size !== settings.mcpServers.length)) {
      return fail('Проверьте имена MCP, параметры подключения и список инструментов.');
    }
    if (settings.skillBindings !== undefined) {
      const bindings = settings.skillBindings;
      if (!Array.isArray(bindings) || bindings.length > 32 || bindings.some(b => !b || typeof b.skillId !== 'string'
        || !/^[\w-]{1,80}$/.test(b.skillId) || !Array.isArray(b.roles) || b.roles.some(role => !AGENT_ROLES.includes(role))
        || new Set(b.roles).size !== b.roles.length) || new Set(bindings.map(b => b.skillId)).size !== bindings.length) {
        return fail('Проверьте выбранные навыки и назначения ролям.');
      }
    }
    for (const connection of settings.connections) {
      if (!connection || !text(connection.id) || !/^[\w-]+$/.test(connection.id) || ids.has(connection.id)) return fail('Connection IDs must be unique.');
      ids.add(connection.id);
      if (!text(connection.label) || !PROVIDER_KINDS.includes(connection.kind)
        || typeof connection.supportsImages !== 'boolean') return fail('Invalid connection.');
      if (connection.credentialEnv && !/^[A-Z_][A-Z0-9_]*$/.test(connection.credentialEnv)) return fail('Credential must be an environment variable name.');
      if (connection.reasoningEffort && !REASONING_EFFORTS.includes(connection.reasoningEffort)) return fail('Invalid reasoning effort.');
      if (connection.isLocal !== undefined && typeof connection.isLocal !== 'boolean') return fail('isLocal must be boolean.');
      if (Object.keys(connection).some((key) => /apiKey|password|secret|token/i.test(key))) return fail('Store credentials on the worker, not in tracker settings.');
      if (connection.kind !== ProviderKind.Native) {
        try {
          const url = new URL(connection.baseUrl ?? '');
          if (!PROVIDER_URL_PROTOCOLS.has(url.protocol) || url.username || url.password || url.search || url.hash) return fail('Invalid provider URL.');
        } catch { return fail('Provider URL is required.'); }
      }
    }
    const profiles = new Map<string, typeof settings.agents[number]>();
    for (const connection of settings.connections) if (connection.nativeRunner !== undefined
      && (!RUNNER_IDS.includes(connection.nativeRunner) || connection.nativeRunner === RunnerId.ModelApi)) return fail('Invalid native runner.');
    for (const agent of settings.agents) {
      if (!agent || !text(agent.id) || !/^[\w-]+$/.test(agent.id) || profiles.has(agent.id)) return fail('Agent IDs must be unique.');
      profiles.set(agent.id, agent);
      if (!AGENT_ROLES.includes(agent.role) || !RUNNER_IDS.includes(agent.runner) || !text(agent.instructions)
        || !text(agent.model) || !agent.model.trim() || !ids.has(agent.connectionId)) return fail('Invalid agent profile, model or connection.');
      const connection = settings.connections.find((entry) => entry.id === agent.connectionId)!;
      if (agent.runner === RunnerId.ModelApi && connection.kind === ProviderKind.Native) return fail('Model API runner requires Ollama or an OpenAI-compatible endpoint.');
      if (agent.runner !== RunnerId.ModelApi && connection.kind !== ProviderKind.Native) return fail('Native runners use their own provider configuration. Use model-api for endpoint connections.');
      if (agent.runner === RunnerId.DeepSeekHarness && !agent.nativeProfile) return fail('DeepSeek Harness requires a worker-side native profile with the selected model.');
      if (agent.runner === RunnerId.Custom && (!text(agent.command) || !agent.command || !Array.isArray(agent.args))) return fail('Custom runner requires an executable and argv.');
      if (agent.args && !agent.args.every(text)) return fail('Runner args must be strings.');
    }

    let doctorAgent: typeof settings.agents[number] | undefined;
    if (settings.doctorAgent) {
      const da = settings.doctorAgent;
      if (text(da.id) && AGENT_ROLES.includes(da.role) && RUNNER_IDS.includes(da.runner)
        && (!da.connectionId || ids.has(da.connectionId))) {
        doctorAgent = {
          id: da.id,
          role: da.role,
          runner: da.runner,
          connectionId: da.connectionId || '',
          model: typeof da.model === 'string' ? da.model : '',
          instructions: typeof da.instructions === 'string' ? da.instructions : '',
          ...(da.command ? { command: da.command } : {}),
          ...(Array.isArray(da.args) && da.args.every(text) ? { args: da.args } : {}),
          ...(da.nativeProfile ? { nativeProfile: da.nativeProfile } : {}),
        };
      }
    }
    if (!settings.pipeline.every((id) => text(id) && profiles.has(id))) return fail('Pipeline references an unknown agent.');
    if (!settings.checks.every((check) => check && text(check.command) && check.command && Array.isArray(check.args) && check.args.every(text))) return fail('Invalid check command.');
    if (settings.pipelineRoutes !== undefined && !Array.isArray(settings.pipelineRoutes)) return fail('Invalid pipeline routes.');
    if (settings.browser && (!text(settings.browser.command) || !settings.browser.command.trim() || !Array.isArray(settings.browser.args)
      || !settings.browser.args.every(text) || !/^\/(?!\/)[^\s\\]*$/.test(settings.browser.readyPath))) return fail('Invalid browser server command or readiness path.');
    const routerProblem = PipelinePolicy.routerProblem(settings);
    if (routerProblem) return fail(routerProblem);
    const routeProblem = PipelinePolicy.routeProblem(settings);
    if (routeProblem) return fail(routeProblem);
    if (!settings.setup.every((check) => check && text(check.command) && check.command && Array.isArray(check.args) && check.args.every(text))) return fail('Invalid setup command.');
    const postOperations = Array.isArray(settings.postOperations) ? settings.postOperations : [];
    if (!postOperations.every((op) => op && text(op.command) && op.command && Array.isArray(op.args) && op.args.every(text) && (op.background === undefined || typeof op.background === 'boolean'))) return fail('Invalid post-operation command.');
    if (!settings.artifactPaths.every((entry) => text(entry) && !entry.includes('..') && !/^(?:[a-z]:|[\/\\])/i.test(entry))) return fail('Artifacts must be relative paths inside the worktree.');
    if (!Number.isInteger(settings.timeoutMinutes) || settings.timeoutMinutes < AUTOMATION_LIMITS.timeoutMinutes.min || settings.timeoutMinutes > AUTOMATION_LIMITS.timeoutMinutes.max
      || !Number.isInteger(settings.maxRevisions) || settings.maxRevisions < AUTOMATION_LIMITS.revisions.min || settings.maxRevisions > AUTOMATION_LIMITS.revisions.max) return fail('Invalid run limits.');
    if (!MERGE_POLICIES.includes(settings.mergePolicy)) return fail('Invalid merge policy.');
    const maxAgentCalls = settings.maxAgentCalls ?? 20;
    const maxStageToolCalls = settings.maxStageToolCalls ?? 60;
    const maxInputTokens = settings.maxInputTokens ?? 5000000;
    const maxRunMinutes = settings.maxRunMinutes ?? 60;
    const execution = { maxParallelRuns: settings.maxParallelRuns ?? 2, dependencyMode: settings.dependencyMode ?? 'isolated',
      maxMergeAttempts: settings.maxMergeAttempts ?? 2, resolveConflicts: settings.resolveConflicts ?? true,
      maxResolverCalls: settings.maxResolverCalls ?? 1, resolverTimeoutMinutes: settings.resolverTimeoutMinutes ?? 3,
      maxResolverToolCalls: settings.maxResolverToolCalls ?? 16 };
    const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
    if (!integer(execution.maxParallelRuns, 1, 8) || !integer(execution.maxMergeAttempts, 1, 3)
      || !integer(execution.maxResolverCalls, 0, 3) || !integer(execution.resolverTimeoutMinutes, 1, 10)
      || !integer(execution.maxResolverToolCalls, 1, 40) || typeof execution.resolveConflicts !== 'boolean'
      || !['isolated', 'linked'].includes(execution.dependencyMode)) return fail('Invalid parallel execution or integration settings.');
    if (!Number.isSafeInteger(maxStageToolCalls) || maxStageToolCalls < 1 || maxStageToolCalls > 200
      || !Number.isSafeInteger(maxAgentCalls) || maxAgentCalls < 1 || maxAgentCalls > 100
      || !Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1 || maxInputTokens > 100000000
      || !Number.isSafeInteger(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > 240) return fail('Invalid run budget.');
    const audit = settings.auditAgent;
    const auditConnection = audit && settings.connections.find(connection => connection.id === audit.connectionId);
    if (audit?.connectionId && (!auditConnection?.baseUrl || auditConnection.kind === ProviderKind.Native ||
      !(auditConnection.isLocal ?? auditConnection.kind === ProviderKind.Ollama) ||
      typeof audit.model !== 'string' || !audit.model.trim())) return fail('Stage audit requires a local API connection and model.');
    // Reconstruct persisted objects so unknown fields cannot carry credentials.
    return {
      repositoryPath: settings.repositoryPath, baseBranch: settings.baseBranch,
      ...(settings.mcpServers?.length ? { mcpServers: structuredClone(settings.mcpServers) } : {}),
      ...(settings.skillBindings?.length ? { skillBindings: settings.skillBindings.map(({ skillId, roles }) => ({skillId, roles: [...roles]})) } : {}),
      connections: settings.connections.map(({ id, label, kind, baseUrl, credentialEnv, supportsImages, reasoningEffort, nativeRunner, isLocal }) => ({ id, label, kind, baseUrl, credentialEnv, supportsImages, reasoningEffort, ...(isLocal !== undefined ? { isLocal } : (kind === ProviderKind.Ollama ? { isLocal: true } : {})), ...(kind === ProviderKind.Native && nativeRunner ? { nativeRunner } : {}) })),
      agents: settings.agents.map(({ id, role, runner, connectionId, model, instructions, nativeProfile, command, args }) => ({ id, role, runner, connectionId, model, instructions, nativeProfile, command, args })),
      ...(settings.browser ? { browser: { command: settings.browser.command, args: [...settings.browser.args], readyPath: settings.browser.readyPath } } : {}),
      ...(settings.routingProfileIds !== undefined ? {routingProfileIds: [...settings.routingProfileIds]} : {}),
      pipeline: settings.pipeline, checks: settings.checks.map(({ command, args }) => ({ command, args })), setup: settings.setup.map(({ command, args }) => ({ command, args })), postOperations: postOperations.map(({ command, args, background }) => ({ command, args, ...(background ? { background } : {}) })), artifactPaths: settings.artifactPaths,
      ...(settings.pipelineRoutes?.length ? { pipelineRoutes: settings.pipelineRoutes.map(({ from, passTo, retry }) => ({
        from, passTo, ...(retry ? { retry: { to: retry.to, limit: retry.limit, exhausted: retry.exhausted } } : {}),
      })) } : {}),
      timeoutMinutes: settings.timeoutMinutes, maxRevisions: settings.maxRevisions, mergePolicy: settings.mergePolicy,
      maxAgentCalls, maxStageToolCalls, maxInputTokens, maxRunMinutes,
      ...(doctorAgent ? { doctorAgent } : {}),
      ...(auditConnection && audit ? { auditAgent: { id: 'stage-audit', role: 'stage-audit', runner: RunnerId.ModelApi,
        connectionId: auditConnection.id, model: audit.model.trim(),
        instructions: typeof audit.instructions === 'string' ? audit.instructions.trim().slice(0, 1500) : '' } } : {}),
      ...(typeof settings.doctorConnectionId === 'string' ? { doctorConnectionId: settings.doctorConnectionId } : {}),
      ...(typeof settings.doctorModel === 'string' ? { doctorModel: settings.doctorModel } : {}),
      ...execution,
    };
  }
}
