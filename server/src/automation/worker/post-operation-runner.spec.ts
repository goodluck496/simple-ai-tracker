import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PostOperationRunner } from './post-operation-runner.js';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';

test('PostOperationRunner skips missing npm scripts with a progress message and executes existing ones', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-post-op-'));
  const executed: string[] = [];
  class FixtureExecutor extends ProcessExecutor {
    public override async run(request: ProcessRequest): Promise<string> {
      executed.push(`${request.command} ${request.args.join(' ')}`);
      return '';
    }
  }

  try {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        scripts: {
          build: 'echo building',
        },
      }),
      'utf8'
    );

    const progress: string[] = [];
    const runner = new PostOperationRunner(new FixtureExecutor());

    // 1. Missing 'test' script: npm test
    await runner.run({ command: 'npm', args: ['test'] }, cwd, cwd, AbortSignal.timeout(5000), line => progress.push(line));
    assert.equal(executed.length, 0);
    assert.ok(progress.some(line => line.includes('Пропуск пост-операции npm test: скрипт "test" отсутствует')));

    // 2. Missing 'lint' script: npm run lint
    await runner.run({ command: 'npm', args: ['run', 'lint'] }, cwd, cwd, AbortSignal.timeout(5000), line => progress.push(line));
    assert.equal(executed.length, 0);
    assert.ok(progress.some(line => line.includes('Пропуск пост-операции npm run lint: скрипт "lint" отсутствует')));

    // 3. Existing 'build' script: npm run build
    await runner.run({ command: 'npm', args: ['run', 'build'] }, cwd, cwd, AbortSignal.timeout(5000), line => progress.push(line));
    assert.equal(executed.length, 1);
    assert.equal(executed[0], 'npm run build');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
