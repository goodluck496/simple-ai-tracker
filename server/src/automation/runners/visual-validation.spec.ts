import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_AUTOMATION_SETTINGS, type AgentJob } from '../../../../shared/automation/contracts.js';
import { ModelApiRunner } from './model-api-runner.js';

test('visual validation uses available images and can inspect the implementation without them', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-visual-'));
  try {
    await fs.writeFile(path.join(cwd, 'existing.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2QAAAAASUVORK5CYII=', 'base64'));
    await fs.writeFile(path.join(cwd, 'styles.css'), '.layout { display: grid; }');
    const job: AgentJob = { runId: 'visual-fixture', cwd, prompt: 'Review the layout.', signal: AbortSignal.timeout(10000),
      profile: { id: 'visual', role: 'visual-validator', runner: 'model-api', model: 'fixture', connectionId: 'api', instructions: '' },
      connection: { id: 'api', label: 'API', kind: 'ollama', baseUrl: 'http://fixture', supportsImages: true },
      settings: { ...DEFAULT_AUTOMATION_SETTINGS, artifactPaths: ['missing.png', 'existing.png'] },
    };
    const useTool = (name: string, args: unknown) => Response.json({ choices: [{ message: {
      tool_calls: [{ id: name, function: { name, arguments: JSON.stringify(args) } }],
    } }] });
    for (const mode of ['screenshot', 'missing', 'text-only']) {
      let turn = 0;
      const request: typeof fetch = async (_url, options) => {
        const input = JSON.parse(String(options?.body));
        const user = input.messages.find((message: { role: string }) => message.role === 'user');
        const tools = input.tools.map((tool: { function: { name: string } }) => tool.function.name);
        assert.ok(tools.includes('read_file'));
        assert.ok(!tools.includes('write_file') && !tools.includes('edit_file'));
        if (mode === 'screenshot') {
          assert.equal(user.content.filter((part: { type: string }) => part.type === 'image_url').length, 1);
        } else if (turn++ === 0) {
          assert.equal(typeof user.content, 'string');
          assert.match(JSON.stringify(input.messages), /No usable screenshot/);
          return useTool('read_file', { path: 'styles.css', startLine: 1, endLine: 1 });
        } else {
          assert.match(JSON.stringify(input.messages), /display: grid/);
        }
        return useTool('finish_task', { verdict: 'pass', summary: 'Reviewed available evidence.', commitMessage: '', questions: [], plan: '', decomposition: [] });
      };
      const result = await new ModelApiRunner(undefined, request).run({ ...job,
        connection: { ...job.connection, supportsImages: mode !== 'text-only' },
        settings: { ...job.settings, artifactPaths: mode === 'missing' ? ['missing.png'] : job.settings.artifactPaths },
      }, () => {});
      assert.equal(JSON.parse(result.text).verdict, 'pass');
    }
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
