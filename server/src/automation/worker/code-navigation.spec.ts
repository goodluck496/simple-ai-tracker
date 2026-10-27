import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorktreeCodeGraph } from './code-navigation.js';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';

test('CodeGraph prepares a private worktree index, synchronizes changes, and fails before model execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-graph-test-')); const calls: ProcessRequest[] = []; const logs: string[] = [];
  class Fixture extends ProcessExecutor {
    public override async run(request: ProcessRequest) {
      calls.push(request); assert.equal(request.cwd, root); assert.equal(request.compactProgress, true);
      if (request.args[0] === 'init') await fs.mkdir(path.join(root, '.codegraph'));
      return 'PRIVATE_INDEX_OUTPUT';
    }
  }
  try {
    const graph = new WorktreeCodeGraph(new Fixture()); const signal = AbortSignal.timeout(5000);
    await graph.prepare(root, signal, text => logs.push(text)); await graph.prepare(root, signal, text => logs.push(text));
    assert.deepEqual(calls.map(r => r.args), [['init', root], ['sync', '--quiet', root]]);
    assert.doesNotMatch(logs.join(''), /PRIVATE_INDEX_OUTPUT/);
    class Missing extends ProcessExecutor { public override async run(): Promise<string> { throw new Error('missing'); } }
    await assert.rejects(new WorktreeCodeGraph(new Missing()).prepare(root, signal, () => undefined), /before calling the agent/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
