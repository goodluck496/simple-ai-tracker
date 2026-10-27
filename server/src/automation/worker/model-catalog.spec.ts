import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerModelCatalog } from './model-catalog.js';
import { ProcessExecutor, type ProcessRequest } from '../runners/process-executor.js';
import { ProviderKind, RunnerId, DEFAULT_AUTOMATION_SETTINGS, type ModelConnection } from '../../../../shared/automation/contracts.js';
import { ProjectAction } from '../../../../shared/automation/project.js';
import { createContainer } from '../../bootstrap/container.js';
import { SilentLogger } from '../../core/logger.js';
import { ModelCatalogKey } from '../../../../shared/automation/model-catalog.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeExecutable } from '../runners/native-executable.js';

const native: ModelConnection = { id: 'native', label: 'Codex', kind: ProviderKind.Native, supportsImages: false };
test('Antigravity 1.4.8 catalog uses its installed executable without inference and preserves exact TSV slugs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-agy-catalog-'));
  try {
    const executable = path.join(root, 'agy', 'bin', 'agy.exe'); await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'fixture');
    let calls = 0; let output = 'Fetching available models...\r\ngemini-4-argon-high\tGemini 4 Argon (High)\r\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\r\n';
    class Fixture extends ProcessExecutor {
      public override async run(request: ProcessRequest): Promise<string> {
        calls++; assert.equal(request.command, executable); assert.deepEqual(request.args, ['models']); return output;
      }
    }
    const catalog = new WorkerModelCatalog(new Fixture(), fetch, { LOCALAPPDATA: root });
    assert.deepEqual(await catalog.list({ connection: native, runner: RunnerId.Antigravity }), [
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High) · gemini-4-argon-high' },
      { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low) · claude-sonnet-5-5-low' },
    ]);
    output = 'Please log in';
    await assert.rejects(catalog.list({ connection: native, runner: RunnerId.Antigravity }), /формат/);
    assert.equal(calls, 2);
    assert.equal(NativeExecutable.antigravity({ SAT_ANTIGRAVITY_PATH: executable }), executable);
    assert.throws(() => NativeExecutable.antigravity({ SAT_ANTIGRAVITY_PATH: path.join(root, 'missing') }), /executable/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
class CatalogExecutor extends ProcessExecutor {
  public calls: ProcessRequest[] = [];
  public override async run(request: ProcessRequest): Promise<string> {
    this.calls.push(request);
    return JSON.stringify({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list' },
      { slug: 'internal', visibility: 'hide' }, { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna' }, { slug: '' }] });
  }
}
test('Codex discovery preserves exact slug, hides internal models and does not run inference', async () => {
  const executor = new CatalogExecutor();
  const service = new WorkerModelCatalog(executor);
  assert.deepEqual(await service.list({ connection: native, runner: RunnerId.Codex }), [{ id: 'gpt-6-luna', label: 'GPT-6-Luna · gpt-6-luna' }]);
  assert.equal(executor.calls[0].command, 'codex'); assert.deepEqual(executor.calls[0].args, ['debug', 'models']);
  await assert.rejects(service.list({ connection: native, runner: RunnerId.ClaudeCode }), /вручную/);
  assert.equal(executor.calls.length, 1);
});
test('API discovery uses worker credentials, exact model IDs and correct paths', async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') });
    return Response.json(String(input).includes('/api/tags') ? { models: [{ name: 'Qwen:8b' }] }
      : { data: [{ id: 'deepseek-test', name: 'DeepSeek Test' }] });
  };
  const service = new WorkerModelCatalog(new CatalogExecutor(), request, { SAT_TEST_KEY: 'private-key' });
  for (const baseUrl of ['http://localhost:11434/', 'http://localhost:11434/v1']) {
    const models = await service.list({ runner: RunnerId.ModelApi, connection: { ...native, kind: ProviderKind.Ollama, baseUrl } });
    assert.equal(models[0].id, 'Qwen:8b'); assert.equal(calls.at(-1)?.url, 'http://localhost:11434/api/tags');
  }
  const connection = { ...native, kind: ProviderKind.OpenAICompatible, baseUrl: 'https://example.invalid/v1/', credentialEnv: 'SAT_TEST_KEY' };
  assert.deepEqual(await service.list({ runner: RunnerId.ModelApi, connection }), [{ id: 'deepseek-test', label: 'DeepSeek Test · deepseek-test' }]);
  assert.equal(calls.at(-1)?.url, 'https://example.invalid/v1/models'); assert.equal(calls.at(-1)?.auth, 'Bearer private-key');
  assert.notEqual(ModelCatalogKey.create({ runner: RunnerId.ModelApi, connection }), ModelCatalogKey.create({ runner: RunnerId.ModelApi, connection: { ...connection, baseUrl: 'http://other' } }));
});
test('structured CLI output above the default log tail is retained when explicitly requested', async () => {
  const size = 560000;
  const output = await new ProcessExecutor().run({ command: process.execPath,
    args: ['-e', `process.stdout.write(JSON.stringify({models:[{slug:'test',description:'x'.repeat(${size})}]}))`],
    cwd: process.cwd(), signal: AbortSignal.timeout(15000), maxOutputChars: 2 * 1024 * 1024 });
  assert.equal(JSON.parse(output).models[0].description.length, size);
});
test('catalog errors never expose remote bodies, secret headers or raw CLI output', async () => {
  const connection = { ...native, kind: ProviderKind.OpenAICompatible, baseUrl: 'https://example.invalid', credentialEnv: 'SAT_KEY' };
  await assert.rejects(new WorkerModelCatalog(new CatalogExecutor(), async () => { throw new Error('Bearer private-key'); }, { SAT_KEY: 'private-key' }).list({ connection, runner: RunnerId.ModelApi }), (error: Error) => !error.message.includes('private-key'));
  await assert.rejects(new WorkerModelCatalog(new CatalogExecutor(), async () => new Response('private-key', { status: 401 }), { SAT_KEY: 'private-key' }).list({ connection, runner: RunnerId.ModelApi }), /HTTP 401/);
  await assert.rejects(new WorkerModelCatalog(new CatalogExecutor(), fetch, {}).list({ connection, runner: RunnerId.ModelApi }), /SAT_KEY/);
  await assert.rejects(new WorkerModelCatalog(new CatalogExecutor(), async () => Response.json({ wrong: [] }), { SAT_KEY: 'private-key' }).list({ connection, runner: RunnerId.ModelApi }), /некорректный каталог/);
});
test('model mailbox validates a draft connection without requiring configured agents or saving settings', () => {
  const app = createContainer({ config: { dbPath: ':memory:' }, logger: new SilentLogger() });
  try {
    const mailbox = app.automationService.projects;
    assert.throws(() => mailbox.enqueue({ action: ProjectAction.Models, path: '' }), /подключение/);
    assert.throws(() => mailbox.enqueue({ action: ProjectAction.Models, path: '', catalog: { runner: RunnerId.ModelApi, connection: { ...native, kind: ProviderKind.OpenAICompatible, baseUrl: 'https://user:secret@example.invalid' } } }), /URL/);
    assert.throws(() => mailbox.enqueue({ action: ProjectAction.Models, path: '', catalog: { runner: RunnerId.ModelApi, connection: native } }), /типу подключения/);
    const request = mailbox.enqueue({ action: ProjectAction.Models, path: '', catalog: { runner: RunnerId.Codex, connection: native } });
    assert.deepEqual(request.catalog, { runner: RunnerId.Codex, connection: { ...native, baseUrl: undefined, credentialEnv: undefined, reasoningEffort: undefined } });
    assert.deepEqual(app.automationService.settings(), DEFAULT_AUTOMATION_SETTINGS);
  } finally { app.close(); }
});
