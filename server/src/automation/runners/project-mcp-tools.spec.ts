import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ModelApiRunner } from './model-api-runner.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../../../shared/automation/contracts.js';
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
