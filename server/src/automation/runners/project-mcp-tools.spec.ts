import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ProjectMcpTools } from './project-mcp-tools.js';

test('project MCP calls only whitelisted tools, bounds text and closes the isolated session', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-project-mcp-'));
  const require = createRequire(import.meta.url);
  const bridge = path.join(cwd, 'fixture.cjs');
  const script = `const {Server}=require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});
const {StdioServerTransport}=require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const {ListToolsRequestSchema,CallToolRequestSchema}=require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});
const server=new Server({name:'fixture-browser',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'snapshot',inputSchema:{type:'object',properties:{}}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:'visible button '.repeat(1000)},{type:'image',mimeType:'image/png',data:'AAAA'}]}));
server.connect(new StdioServerTransport());`;
  await fs.writeFile(bridge, script, 'utf8');
  const tools = new ProjectMcpTools({ cwd, signal: AbortSignal.timeout(20000), projectMcp: [{ name: 'browser', command: process.execPath, args: [bridge], envVars: [], tools: ['snapshot'] }] });
  try {
    await assert.rejects(tools.call('browser', 'unapproved', {}), /not enabled/);
    const result = await tools.call('browser', 'snapshot', {}) as { content: string; limited: boolean; omittedNonText: boolean };
    assert.equal(result.content.length, 6000); assert.equal(result.limited, true); assert.equal(result.omittedNonText, true);
    assert.match(result.content, /visible button/);
  } finally { await tools.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});
