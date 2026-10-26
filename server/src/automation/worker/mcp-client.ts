import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface TrackerChannel { call<T>(name: string, args?: Record<string, unknown>): Promise<T>; }

export class McpTrackerChannel implements TrackerChannel {
  private readonly client = new Client({ name: 'simple-ai-tracker-worker', version: '1.0.0' });
  public constructor(private readonly workspace: string) {}
  public async connect(): Promise<void> {
    const command = process.env.SAT_MCP_COMMAND ?? process.execPath;
    const args: unknown = JSON.parse(process.env.SAT_MCP_ARGS ?? '["dist/server/mcp.mjs"]');
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) throw new Error('SAT_MCP_ARGS must be a JSON string array.');
    // SDK only inherits a small OS whitelist; preserve the explicit tracker store selection.
    const env: Record<string, string> = {};
    for (const key of ['SAT_HOME', 'SAT_DB_PATH', 'SAT_WORKSPACE', 'SAT_BACKUP_ENABLED']) {
      const value = process.env[key]; if (value !== undefined) env[key] = value;
    }
    await this.client.connect(new StdioClientTransport({ command, args, env, stderr: 'inherit' }));
  }
  public async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.client.callTool({ name, arguments: { ...args, workspace: this.workspace } });
    const content = result.content as { type: string; text?: string }[];
    const text = content.filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '').join('\n');
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }
  public async close(): Promise<void> { await this.client.close(); }
}
