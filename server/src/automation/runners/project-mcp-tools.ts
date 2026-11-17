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
    if (!('content' in response) || !Array.isArray(response.content)) throw new Error('MCP returned no content.');
    return ProjectMcpTools.result({content:response.content,isError:response.isError === true});
  }
  public static result(response: { content: unknown; isError?: boolean }) {
    const blocks = response.content as { type: string; text?: string; mimeType?: string; data?: string }[];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    const images: string[] = [];
    let omittedNonText = false;
    for (const block of blocks.filter(b => b.type !== 'text')) {
      if (block.type === 'image' && /^image\/(png|jpeg|webp)$/.test(block.mimeType ?? '')
        && typeof block.data === 'string' && block.data.length <= 2800000 && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data)
        && images.length < 4) images.push(`data:${block.mimeType};base64,${block.data}`);
      else omittedNonText = true;
    }
    return { error: response.isError === true, content: text.slice(0, 6000), limited: text.length > 6000, images, omittedNonText };
  }
  public async close(): Promise<void> { await Promise.allSettled([...this.clients.values()].map(client => client.close())); this.clients.clear(); }
}
