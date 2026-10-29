import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AgentJob } from '../../../../shared/automation/contracts.js';
import { TaskEnvironment } from './task-environment.js';

/** Lazy, per-job project MCP connections. No account-wide tool inventory or writable tracker access. */
export class ProjectMcpTools {
  private readonly clients = new Map<string, Client>();
  public constructor(private readonly job: Pick<AgentJob, 'cwd' | 'signal' | 'projectMcp'>) {}
  public async call(serverName: unknown, toolName: unknown, args: unknown): Promise<unknown> {
    const server = this.job.projectMcp?.find(server => server.name === serverName);
    if (!server || typeof toolName !== 'string' || !server.tools.includes(toolName)) throw new Error('Project MCP tool is not enabled for this job.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP arguments must be an object.');
    let client = this.clients.get(server.name);
    if (!client) {
      const source = TaskEnvironment.create();
      const env: Record<string, string> = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'PORT', ...server.envVars])
        if (source[key] !== undefined) env[key] = source[key]!;
      client = new Client({ name: 'tracker-project-tools', version: '1' });
      try { await client.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: this.job.cwd, env, stderr: 'ignore' })); }
      catch (error) { await client.close(); throw error; }
      this.clients.set(server.name, client);
    }
    const response = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, { signal: this.job.signal });
    const text = (response.content as { type: string; text?: string }[]).filter(content => content.type === 'text').map(content => content.text ?? '').join('\n');
    return { error: response.isError === true, content: text.slice(0, 6000), limited: text.length > 6000,
      omittedNonText: (response.content as { type: string }[]).some(content => content.type !== 'text') };
  }
  public async close(): Promise<void> { await Promise.allSettled([...this.clients.values()].map(client => client.close())); this.clients.clear(); }
}
