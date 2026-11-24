import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { AgentJob } from '../../../../shared/automation/contracts.js';
import type { ProcessRequest } from './process-executor.js';
import { configureNativeProjectMcp } from './native-project-mcp-config.js';

test('native MCP configuration is scoped to the invocation and restores existing files', async () => {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sat-native-mcp-')));
  const job = { cwd, signal: AbortSignal.timeout(10000) } as AgentJob;
  const url = 'http://127.0.0.1:1234/session/0';
  const urls = { playwright: url };
  let inventoryCalls = 0;
  let expectedAuth = '';
  const api = createServer((request, response) => {
    if (!request.url?.startsWith('/api/mcp?') || request.headers.authorization !== expectedAuth) {
      response.writeHead(401).end();
      return;
    }
    const data = ++inventoryCalls === 1 ? [] : [{ name: 'sat_playwright', status: { status: 'connected' } }];
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const openCodeUrl = 'http://127.0.0.1:' + (api.address() as AddressInfo).port;
  const executor = { async run(request: ProcessRequest) {
    if (request.args[0] === '--version') return 'opencode v2.2.6';
    assert.deepEqual(request.args, ['serve', '--hostname', '127.0.0.1', '--port', '0']);
    assert.ok(request.env?.OPENCODE_PASSWORD);
    expectedAuth = 'Basic ' + Buffer.from('opencode:' + request.env.OPENCODE_PASSWORD).toString('base64');
    request.onStdout?.('server listening on ' + openCodeUrl + '\n');
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    return '';
  } };
  const read = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
  try {
    const antigravity = path.join(cwd, '.agents/mcp_config.json');
    await fs.mkdir(path.dirname(antigravity));
    const original = '{ "mcpServers": { "docs": { "serverUrl": "https://example.org/mcp" } } }\n';
    await fs.writeFile(antigravity, original);
    const antigravityConfig = await configureNativeProjectMcp('antigravity', job, urls, [], executor);
    assert.deepEqual((await read(antigravity)).mcpServers, {
      docs: { serverUrl: 'https://example.org/mcp' }, sat_playwright: { serverUrl: url },
    });
    await antigravityConfig.close();
    assert.equal(await fs.readFile(antigravity, 'utf8'), original);

    const opencode = path.join(cwd, '.opencode/opencode.jsonc');
    await fs.mkdir(path.dirname(opencode));
    const jsonc = '{\n // user settings\n "mcp": {"servers": {},},\n}\n';
    await fs.writeFile(opencode, jsonc);
    const openCodeArgs = ['run', 'prompt'];
    const openCodeConfig = await configureNativeProjectMcp('opencode', job, urls, openCodeArgs, executor);
    try {
      assert.equal(inventoryCalls, 2);
      assert.deepEqual(openCodeArgs, ['--server', openCodeUrl, 'run', 'prompt']);
      assert.deepEqual((await read(opencode)).mcp.servers.sat_playwright,
        { type: 'remote', url, oauth: false, codemode: false, disabled: false });
    } finally { await openCodeConfig.close(); }
    assert.equal(await fs.readFile(opencode, 'utf8'), jsonc);

    const deepSeekArgs = ['--profile', 'headless', 'prompt'];
    const deepSeekConfig = await configureNativeProjectMcp('deepseek-harness', job, urls, deepSeekArgs, executor);
    const patch = deepSeekArgs[3];
    assert.deepEqual(deepSeekArgs, ['--profile', 'headless', '--patch', patch, 'prompt']);
    const [layer] = await read(patch);
    assert.equal(layer.insert[0].name, '@deepseek-ai/dsh-mcp-client');
    assert.deepEqual(layer.insert[0].config,
      { serverName: 'sat_playwright', transport: 'streamable-http', url, failOnStartupError: true });
    await deepSeekConfig.close();
    await assert.rejects(fs.access(patch), { code: 'ENOENT' });
  } finally {
    api.closeAllConnections();
    await new Promise<void>(resolve => api.close(() => resolve()));
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
