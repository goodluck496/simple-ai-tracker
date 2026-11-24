import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AgentJob } from '../../../../shared/automation/contracts.js';
import { listProjectMcpTools, projectMcpTransport } from './mcp-transport.js';

/** Scope native CLI discovery and calls to the current stage's approved tools. */
export async function openNativeProjectMcp(job: Pick<AgentJob, 'cwd' | 'projectMcp' | 'signal'>) {
  const stop = new AbortController();
  const signal = AbortSignal.any([job.signal, stop.signal]);
  const prefix = '/' + randomUUID();
  const endpoints = new Map((job.projectMcp ?? []).map((server, index) => {
    const client = new Client({ name: 'sat-native-project-mcp', version: '1' });
    const transport = projectMcpTransport(server, job.cwd);
    let connection: Promise<void> | undefined;
    return [prefix + '/' + index, { name: server.name, client, transport,
      connect: () => connection ??= client.connect(transport),
      list: async () => ({ tools: (await listProjectMcpTools(client, signal)).filter(tool => server.tools.includes(tool.name)) }),
      call: (name: string, args?: Record<string, unknown>, requestSignal?: AbortSignal) => {
        if (!server.tools.includes(name)) throw new McpError(ErrorCode.InvalidParams, 'Project MCP tool is not enabled for this role.');
        return client.callTool({ name, arguments: args }, undefined, { signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal });
      },
    }] as const;
  }));
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const endpoint = endpoints.get(request.url ?? '');
    if (!endpoint || request.headers.origin) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const server = new Server({ name: endpoint.name, version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await endpoint.connect();
      return endpoint.list();
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      await endpoint.connect();
      return endpoint.call(params.name, params.arguments, extra.signal);
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  };
  const http = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Cannot bind the project MCP bridge.');
  return {
    urls: Object.fromEntries([...endpoints].map(([route, endpoint]) => [endpoint.name, 'http://127.0.0.1:' + address.port + route])),
    close: async () => {
      stop.abort();
      const closed = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      http.closeAllConnections();
      await Promise.allSettled([...endpoints.values()].map(async endpoint => {
        await endpoint.client.close();
        await endpoint.transport.close();
      }));
      await closed;
    },
  };
}
