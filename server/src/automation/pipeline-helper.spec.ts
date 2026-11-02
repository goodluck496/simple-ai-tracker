import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineHelper } from './pipeline-helper.js';
import { ProviderKind, type AutomationSettings } from '../../../shared/automation/contracts.js';
import { CommitMessage } from '../../../shared/automation/commit-message.js';

describe('PipelineHelper', () => {
  it('extracts key errors deterministically from compiler/test output', () => {
    const rawOutput = `
> test
> ng build
Compiling @angular/core : es2022 as esm2022
Compiling @angular/common : es2022 as esm2022
[INFO] Processing files
src/app/sidebar.component.ts:42:15 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
  const id: number = target;
                      ~~~~~~
src/app/sidebar.component.ts:89:10 - error TS2304: Cannot find name 'PrimeNGDrawer'.
[INFO] Finished compilation with 2 errors.
Done in 12.3s
    `;

    const extracted = PipelineHelper.extractKeyErrors(rawOutput);
    assert.ok(extracted.includes('error TS2345'));
    assert.ok(extracted.includes('error TS2304'));
    assert.ok(!extracted.includes('Compiling @angular/core'));
  });

  it('repairs invalid commit messages gracefully without throwing', async () => {
    const taskId = 'SAT-99';
    const title = 'Обновление боковой панели';

    // 1. Invalid english message
    const repaired = await PipelineHelper.repairCommitMessage('fix sidebar bug', taskId, title);
    assert.ok(repaired.startsWith(`[#${taskId}] - `));
    assert.doesNotThrow(() => CommitMessage.validate(repaired, taskId));

    // 2. Already valid message
    const valid = `[#${taskId}] - Добавлена новая панель навигации, чтобы улучшить доступ к разделам`;
    const unchanged = await PipelineHelper.repairCommitMessage(valid, taskId, title);
    assert.equal(unchanged, valid);
  });

  it('uses mock LLM request when available', async () => {
    const mockSettings: AutomationSettings = {
      repositoryPath: '',
      baseBranch: 'master',
      connections: [
        {
          id: 'conn-ollama',
          kind: ProviderKind.Ollama,
          baseUrl: 'http://localhost:11434',
          isLocal: true,
          supportsImages: false,
        }
      ],
      agents: [],
      pipeline: [],
      checks: [],
      setup: [],
      artifactPaths: [],
      timeoutMinutes: 10,
      maxRevisions: 1,
      maxAgentCalls: 5,
      maxInputTokens: 100000,
      maxRunMinutes: 10,
      mergePolicy: 'local',
      maxStageToolCalls: 10,
      maxParallelRuns: 1,
      dependencyMode: 'isolated',
      maxMergeAttempts: 1,
      resolveConflicts: false,
      maxResolverCalls: 1,
      resolverTimeoutMinutes: 1,
      maxResolverToolCalls: 5,
      doctorModel: 'qwen3:8b'
    };

    const mockFetch: typeof fetch = async () => {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '[#SAT-99] - Скорректированы стили панели, чтобы устранить наложение элементов'
              }
            }
          ]
        })
      } as unknown as Response;
    };

    const repaired = await PipelineHelper.repairCommitMessage('bad message', 'SAT-99', 'Тест панели', '', mockSettings, mockFetch);
    assert.equal(repaired, '[#SAT-99] - Скорректированы стили панели, чтобы устранить наложение элементов');
    assert.doesNotThrow(() => CommitMessage.validate(repaired, 'SAT-99'));
  });

  it('compresses build/test errors using LLM when available', async () => {
    const mockSettings: AutomationSettings = {
      repositoryPath: '',
      baseBranch: 'master',
      connections: [
        {
          id: 'conn-ollama',
          kind: ProviderKind.Ollama,
          baseUrl: 'http://localhost:11434',
          isLocal: true,
          supportsImages: false,
        }
      ],
      agents: [],
      pipeline: [],
      checks: [],
      setup: [],
      artifactPaths: [],
      timeoutMinutes: 10,
      maxRevisions: 1,
      maxAgentCalls: 5,
      maxInputTokens: 100000,
      maxRunMinutes: 10,
      mergePolicy: 'local',
      maxStageToolCalls: 10,
      maxParallelRuns: 1,
      dependencyMode: 'isolated',
      maxMergeAttempts: 1,
      resolveConflicts: false,
      maxResolverCalls: 1,
      resolverTimeoutMinutes: 1,
      maxResolverToolCalls: 5,
      doctorModel: 'qwen3:8b'
    };

    const mockFetch: typeof fetch = async () => {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Сбой компиляции TypeScript: ошибка TS2345 в файле sidebar.component.ts:42 (несовпадение типов string и number).'
              }
            }
          ]
        })
      } as unknown as Response;
    };

    const raw = 'x'.repeat(600) + '\nerror TS2345: Argument of type string is not assignable to number';
    const compressed = await PipelineHelper.compressErrorLog(raw, mockSettings, mockFetch);
    assert.ok(compressed.includes('Сбой компиляции TypeScript: ошибка TS2345'));
  });
});
