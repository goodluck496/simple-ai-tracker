import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AppContainer } from '../bootstrap/container.js';
import { TrackerToolRegistry } from './tools.js';

export const MCP_SERVER_NAME = 'simple-ai-tracker';
export const MCP_SERVER_VERSION = '1.0.0';

/**
 * MCP-сервер поверх stdio.
 *
 * Помимо инструментов отдаёт поле `instructions`: жёсткие правила работы
 * с трекером приходят клиенту сразу при инициализации сессии — агенту не нужно
 * угадывать регламент.
 */
export class TrackerMcpServer {
  private readonly registry: TrackerToolRegistry;

  public constructor(private readonly app: AppContainer) {
    this.registry = new TrackerToolRegistry(app);
  }

  public createServer(): Server {
    const server = new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      {
        capabilities: { tools: {} },
        instructions: this.app.instructionsService.get(),
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.registry.definitions() }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      this.app.logger.info('MCP tool call', { name });
      return this.registry.call(name, args);
    });

    return server;
  }

  public async serve(): Promise<void> {
    const server = this.createServer();
    await server.connect(new StdioServerTransport());
  }
}
