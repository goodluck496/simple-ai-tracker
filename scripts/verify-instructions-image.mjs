import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/verify-instructions-image.mjs IMAGE');
const expected = readFileSync(new URL('../AGENT_INSTRUCTIONS.md', import.meta.url));
const actual = spawnSync('docker', ['run', '--rm', '--entrypoint', 'node', image, '-e',
  "process.stdout.write(require('node:fs').readFileSync('/app/AGENT_INSTRUCTIONS.md'))"], { timeout: 30000 });
assert.equal(actual.status, 0, actual.stderr?.toString());
assert.deepEqual(actual.stdout, expected);
// New ephemeral container, isolated temporary DB, no bind mounts or model runners.
const transport = new StdioClientTransport({ command: 'docker', args: ['run', '--rm', '-i',
  '-e', 'SAT_DB_PATH=/tmp/sat-packaging/tracker.db', '--entrypoint', 'node', image, 'dist/server/mcp.mjs'], stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });
const client = new Client({ name: 'packaging-regression', version: '1.0' });
let timeout;
try {
  await Promise.race([client.connect(transport), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('MCP packaging check timed out')), 20000);
  })]);
  assert.equal(client.getInstructions(), expected.toString('utf8'));
  assert.equal(/ENOENT.*AGENT_INSTRUCTIONS|AGENT_INSTRUCTIONS.*ENOENT/.test(stderr), false);
  console.log('PASS: runtime instructions byte equality, MCP handshake and no missing-instructions warning');
} finally { clearTimeout(timeout); await client.close(); }
