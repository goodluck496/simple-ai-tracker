import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectEnvironment } from './project-environment.js';
import { AgentRunnerRegistry } from './registry.js';
import type { AgentJob } from '../../../../shared/automation/contracts.js';

test('project policy loads selected skills once, records hashes and rejects missing/oversized/escaping files before runner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-policy-'));
  const cwd = path.join(root, 'worktree'); await fs.mkdir(path.join(cwd, 'docs'), { recursive: true });
  const job = { cwd, prompt: 'TASK', profile: { role: 'developer', runner: 'codex' }, signal: AbortSignal.timeout(10000) } as AgentJob;
  const profile = async (value: unknown) => fs.writeFile(path.join(cwd, 'docs/agent-environment.json'), JSON.stringify(value));
  try {
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Обязательные правила');
    await fs.writeFile(path.join(cwd, 'docs/dev.md'), 'Developer skill');
    await profile({ version: 1, instructions: [{ path: 'AGENTS.md' }], skills: [{ path: 'docs/dev.md', roles: ['developer'] }, { path: 'missing.md', roles: ['tester'] }] });
    const logs: string[] = [];
    const result = await new ProjectEnvironment().prepare(job, line => logs.push(line));
    assert.equal(result.prompt.split('Обязательные правила').length, 2);
    assert.match(result.prompt, /Developer skill/);
    assert.equal(logs.join('').includes('Обязательные правила'), false);
    const receipt = JSON.parse(await fs.readFile(path.join(cwd, '.sat/environment-developer.json'), 'utf8'));
    assert.equal(receipt.files.length, 2); assert.match(receipt.files[0].sha256, /^[a-f0-9]{64}$/);
    await profile({ version: 1, instructions: [{ path: 'missing.md' }] });
    await assert.rejects(new AgentRunnerRegistry().get('codex').run(job, () => {}), /ENOENT/);
    await profile({ version: 1, instructions: [{ path: '../outside.md' }] });
    await assert.rejects(new ProjectEnvironment().prepare(job, () => {}), /relative/);
    await fs.mkdir(path.join(root, 'outside'));
    await fs.writeFile(path.join(root, 'outside/file.md'), 'outside');
    await fs.symlink(path.join(root, 'outside'), path.join(cwd, 'linked'), 'junction');
    await profile({ version: 1, instructions: [{ path: 'linked/file.md' }] });
    await assert.rejects(new ProjectEnvironment().prepare(job, () => {}), /escapes/);
    await fs.writeFile(path.join(cwd, 'docs/dev.md'), 'x'.repeat(48001));
    await profile({ version: 1, skills: [{ path: 'docs/dev.md' }] });
    await assert.rejects(new ProjectEnvironment().prepare(job, () => {}), /Nothing was truncated/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project MCP probes real stdio handshake and paginated tools; rejects unsupported runners and missing tools without model calls', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-mcp-policy-'));
  await fs.mkdir(path.join(cwd, 'docs'));
  const job = { cwd, prompt: 'TASK', profile: { role: 'developer', runner: 'codex' }, signal: AbortSignal.timeout(10000) } as AgentJob;
  const server = { name: 'project-data', command: process.execPath, args: ['{worktreeRoot}/fixture.cjs'], envVars: [], tools: ['lookup'] };
  const profile = async () => fs.writeFile(path.join(cwd, 'docs/agent-environment.json'), JSON.stringify({ version: 1, mcp: [server] }));
  try {
    await fs.writeFile(path.join(cwd, 'fixture.cjs'), `require('readline').createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line); if(r.id===undefined)return;
      let result;
      if(r.method==='initialize') result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
      else if(r.method==='tools/list') result=r.params?.cursor ? {tools:[{name:'lookup',inputSchema:{type:'object'}}]} : {tools:[],nextCursor:'second'};
      else throw Error('Preflight must never call application tools');
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
    });`);
    await profile();
    const lines: string[] = [];
    const result = await new ProjectEnvironment().prepare(job, text => lines.push(text));
    assert.equal(path.resolve(result.projectMcp![0].args[0]), path.join(cwd, 'fixture.cjs'));
    assert.match(lines.join(''), /initialize\/listTools OK/);
    await assert.rejects(new ProjectEnvironment().prepare({ ...job, profile: { ...job.profile, runner: 'deepseek-harness' } }, () => {}), /requires Codex or Model API/);
    assert.equal((await new ProjectEnvironment().prepare({ ...job, profile: { ...job.profile, runner: 'model-api' } }, () => {})).projectMcp?.length, 1);
    server.tools = ['missing']; await profile();
    await assert.rejects(new ProjectEnvironment().prepare(job, () => {}), /preflight failed: project-data/);
    server.command = 'nonexistent-sat-fixture-executable'; await profile();
    await assert.rejects(new ProjectEnvironment().prepare(job, () => {}), /preflight failed/);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
