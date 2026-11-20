import { AGENT_ROLES, type AgentRole } from './contracts.js';

interface McpOptions { name: string; tools: string[]; roles?: AgentRole[]; }
export type ProjectMcp = McpOptions & (
  {command:string; args:string[]; envVars:string[]; url?:never} |
  {url:string; bearerTokenEnvVar?:string; command?:never}
);

/** Settings and repository manifests share the same connection format. */
export function validMcp(value: unknown): value is ProjectMcp {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const list = (x: unknown): x is string[] => Array.isArray(x) && x.every(item => typeof item === 'string');
  const envName = (name: unknown) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  if (typeof v.name !== 'string' || !/^[a-zA-Z][\w-]*$/.test(v.name) || ['codegraph','simple-ai-tracker'].includes(v.name)
    || !list(v.tools) || !v.tools.every(tool => !!tool.trim())
    || (v.roles !== undefined && (!list(v.roles) || !v.roles.every(role => AGENT_ROLES.includes(role as AgentRole))))) return false;
  const keys = ['name','tools','roles'];
  if (v.url !== undefined) {
    if (typeof v.url !== 'string' || !URL.canParse(v.url)) return false;
    const url = new URL(v.url);
    return !url.username && !url.password && !url.hash && !url.search &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) &&
      (v.bearerTokenEnvVar === undefined || envName(v.bearerTokenEnvVar)) &&
      Object.keys(v).every(key => [...keys,'url','bearerTokenEnvVar'].includes(key));
  }
  return typeof v.command === 'string' && !!v.command.trim() && list(v.args) && list(v.envVars) && v.envVars.every(envName)
    && Object.keys(v).every(key => [...keys,'command','args','envVars'].includes(key));
}
