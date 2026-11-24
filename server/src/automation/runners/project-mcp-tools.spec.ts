import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProjectWorker } from '../worker/project-worker.js';
import { ProjectAction } from '../../../../shared/automation/project.js';
import { ModelApiRunner } from './model-api-runner.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../../shared/automation/contracts.js';
import { ProjectMcpTools } from './project-mcp-tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openNativeProjectMcp } from './native-project-mcp.js';

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
    assert.equal(result.content.length, 6000); assert.equal(result.limited, true); assert.equal(result.omittedNonText, false);
    assert.match(result.content, /visible button/);
    for (const vision of [true,false]) {
      let turn=0;
      const request: typeof fetch=async (_url,options)=>{
        const input=JSON.parse(String(options?.body));
        if(turn++===0) return Response.json({choices:[{message:{tool_calls:[0,1].map(i=>({id:'browser-'+i,function:{name:'call_project_tool',arguments:JSON.stringify({server:'browser',tool:'snapshot',arguments:{}})}}))}}]});
        const toolResults=input.messages.filter((m:{role:string})=>m.role==='tool');assert.equal(toolResults.length,2);
        assert.ok(!JSON.stringify(toolResults).includes('base64'));
        const images=input.messages.filter((m:{role:string,content:unknown})=>m.role==='user'&&Array.isArray(m.content));
        assert.equal(images.length,vision?1:0);
        if(vision) assert.equal(images[0].content.filter((part:{type:string})=>part.type==='image_url').length,2);
        else assert.match(JSON.stringify(input.messages),/cannot inspect images/);
        return Response.json({choices:[{message:{tool_calls:[{id:'finish',function:{name:'finish_task',arguments:JSON.stringify({verdict:'pass',summary:'fixture verified'})}}]}}]});
      };
      await new ModelApiRunner(undefined,request).run({runId:'image-fixture',cwd,prompt:'Inspect browser',signal:AbortSignal.timeout(20000),
        connection:{id:'api',kind:'ollama',baseUrl:'http://fixture',label:'Fixture',supportsImages:vision},
        profile:{id:'tester',role:'tester',runner:'model-api',model:'fixture',connectionId:'api',instructions:''},
        settings:structuredClone(DEFAULT_AUTOMATION_SETTINGS),projectMcp:[{name:'browser',command:process.execPath,args:[bridge],envVars:[],tools:['snapshot']}]},()=>{});
    }
  } finally { await tools.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});


test('MCP screenshot transport bounds images and explicitly marks unsupported artifacts', () => {
  const result = ProjectMcpTools.result({content:[{type:'image',mimeType:'image/png',data:'AAAA'},
    {type:'image',mimeType:'image/svg+xml',data:'AAAA'}, {type:'image',mimeType:'image/png',data:'A'.repeat(2800001)}]});
  assert.deepEqual(result.images,['data:image/png;base64,AAAA']); assert.equal(result.omittedNonText,true);
  assert.equal(ProjectMcpTools.result({content:Array.from({length:6},()=>({type:'image',mimeType:'image/png',data:'AAAA'}))}).images.length,4);
});

test('worker discovers HTTP tools without executing them and exposes only approved calls', async () => {
  const calls: string[] = [];
  const fixture = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    calls.push(message.method);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const results: Record<string, unknown> = {
      initialize: {protocolVersion: message.params?.protocolVersion, capabilities: {tools:{}}, serverInfo:{name:'fixture',version:'1'}},
      'tools/list': {tools:['lookup','other'].map(name => ({name,inputSchema:{type:'object'}}))},
      'tools/call': {content:[{type:'text',text:'fixture result'}]},
    };
    res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:results[message.method]}));
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const server = {name:'search',url:'http://127.0.0.1:' + (fixture.address() as AddressInfo).port + '/mcp', tools:['lookup']};
  const cwd = os.tmpdir();
  const tools = new ProjectMcpTools({cwd, signal:AbortSignal.timeout(20000),projectMcp:[server]});
  try {
    const worker = new ProjectWorker({async call() { throw new Error('Unexpected tracker call'); }}, 'fixture');
    const probe = await worker.execute({action:ProjectAction.ProbeMcp,path:cwd,mcp:{...server,tools:[]}});
    assert.deepEqual(probe.mcpTools, ['lookup','other']);
    assert.equal(calls.includes('tools/call'), false);
    await assert.rejects(tools.call(server.name, 'other', {}), /not enabled/);
    assert.match(JSON.stringify(await tools.call(server.name, 'lookup', {})), /fixture result/);
    assert.equal(calls.filter(name => name === 'tools/call').length, 1);
    const bridge = await openNativeProjectMcp({ cwd, signal: AbortSignal.timeout(20000), projectMcp: [server] });
    const client = new Client({ name: 'cli-fixture', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.urls.search)));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['lookup']);
      await assert.rejects(client.callTool({ name: 'other' }), /not enabled/);
      assert.match(JSON.stringify(await client.callTool({ name: 'lookup' })), /fixture result/);
      assert.equal(calls.filter(name => name === 'tools/call').length, 2);
    } finally {
      await client.close();
      await bridge.close();
    }
  } finally {
    await tools.close();
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});
