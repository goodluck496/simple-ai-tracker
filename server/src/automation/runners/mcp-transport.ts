import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ProjectMcp } from '../../../../shared/automation/project-mcp.js';
import { TaskEnvironment } from './task-environment.js';

export function bindProjectMcp(server: ProjectMcp, cwd: string): ProjectMcp {
  const environment = TaskEnvironment.create();
  const names = server.url !== undefined ? (server.bearerTokenEnvVar ? [server.bearerTokenEnvVar] : []) : server.envVars;
  for (const key of names) if (!environment[key]) throw new Error('Missing or host-reserved project MCP environment variable: ' + key);
  if (server.url !== undefined) return server;
  const bind = (text: string) => text.replaceAll('{worktreeRoot}', cwd);
  return { ...server, command: bind(server.command), args: server.args.map(bind) };
}
export function projectMcpTransport(server: ProjectMcp, cwd: string) {
  const source = TaskEnvironment.create();
  if (server.url !== undefined) {
    const token = server.bearerTokenEnvVar && source[server.bearerTokenEnvVar];
    return new StreamableHTTPClientTransport(new URL(server.url), {requestInit:{
      redirect: 'error', ...(token ? {headers:{Authorization:'Bearer ' + token}} : {}),
    }});
  }
  const env: Record<string,string> = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','USERPROFILE','HOME','TEMP','TMP','PORT', ...server.envVars]) {
    if (source[key] !== undefined) env[key] = source[key]!;
  }
  return new StdioClientTransport({command:server.command,args:server.args,cwd,env,stderr:'ignore'});
}
