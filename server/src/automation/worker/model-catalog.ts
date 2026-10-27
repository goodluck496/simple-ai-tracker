import os from 'node:os';
import { ProviderKind, RunnerId } from '../../../../shared/automation/contracts.js';
import { MODEL_CATALOG_LIMITS, type ModelCatalogInput, type ModelOption } from '../../../../shared/automation/model-catalog.js';
import { ProcessExecutor } from '../runners/process-executor.js';
import { NativeExecutable } from '../runners/native-executable.js';

type CatalogRow = Record<string, unknown>;
/** Discovery runs on the host with the same CLI login and environment as execution. */
export class WorkerModelCatalog {
  public constructor(private readonly executor = new ProcessExecutor(), private readonly request: typeof fetch = fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env) {}

  public async list(input: ModelCatalogInput): Promise<ModelOption[]> {
    let rows: unknown; let idField: string; let labelField: string;
    if (input.connection.kind === ProviderKind.Native) {
      if (input.runner === RunnerId.Antigravity) {
        let output: string;
        try { output = await this.executor.run({ command: NativeExecutable.antigravity(this.environment), args: ['models'], cwd: os.homedir(),
          signal: AbortSignal.timeout(MODEL_CATALOG_LIMITS.timeoutMs), maxOutputChars: MODEL_CATALOG_LIMITS.maxBytes }); }
        catch { throw new Error('Не удалось получить каталог Antigravity. Проверьте установку agy и вход в аккаунт на компьютере worker.'); }
        rows = this.antigravityRows(output); idField = 'id'; labelField = 'name';
      } else {
      if (input.runner !== RunnerId.Codex) throw new Error('Этот CLI пока не предоставляет поддерживаемый каталог. Укажите точный ID вручную или выберите API-подключение.');
      let output: string;
      try { output = await this.executor.run({ command: 'codex', args: ['debug', 'models'], cwd: os.homedir(),
        signal: AbortSignal.timeout(MODEL_CATALOG_LIMITS.timeoutMs), maxOutputChars: MODEL_CATALOG_LIMITS.maxBytes }); }
      catch { throw new Error('Не удалось получить каталог Codex. Проверьте вход в Codex и поддержку команды codex debug models установленной версией CLI.'); }
      rows = this.parse(output).models; idField = 'slug'; labelField = 'display_name';
      }
    } else {
      const connection = input.connection;
      const base = (connection.baseUrl ?? '').replace(/\/+$/, '');
      const ollama = connection.kind === ProviderKind.Ollama;
      const url = ollama ? `${base.replace(/\/v1$/, '')}/api/tags` : `${base}/models`;
      const secret = connection.credentialEnv ? this.environment[connection.credentialEnv] : undefined;
      if (connection.credentialEnv && !secret) throw new Error(`На worker не задана переменная ${connection.credentialEnv}.`);
      let response: Response;
      try { response = await this.request(url, { headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        signal: AbortSignal.timeout(MODEL_CATALOG_LIMITS.timeoutMs), redirect: 'error' }); }
      catch { throw new Error('Не удалось подключиться к API моделей с компьютера worker. Проверьте адрес и доступность сервиса.'); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`API списка моделей вернул HTTP ${response.status}. Проверьте адрес и авторизацию на worker.`); }
      const data = this.parse(await this.read(response));
      rows = ollama ? data.models : data.data; idField = ollama ? 'name' : 'id'; labelField = 'name';
    }
    if (!Array.isArray(rows)) throw new Error('Провайдер вернул некорректный каталог моделей.');
    const models = new Map<string, ModelOption>();
    for (const value of rows) {
      if (!value || typeof value !== 'object') continue;
      const row = value as CatalogRow;
      if (row.visibility === 'hide') continue;
      const id = row[idField]; const title = row[labelField];
      if (typeof id !== 'string' || !id.trim() || id.length > MODEL_CATALOG_LIMITS.textLength || /[\u0000-\u001f]/.test(id)) continue;
      const name = typeof title === 'string' ? title.slice(0, MODEL_CATALOG_LIMITS.textLength) : id;
      models.set(id, { id, label: name === id ? id : `${name} · ${id}` });
      if (models.size > MODEL_CATALOG_LIMITS.maxModels) throw new Error('Каталог превышает лимит моделей. Используйте ручной ввод ID.');
    }
    return [...models.values()];
  }
  private antigravityRows(output: string): CatalogRow[] {
    if (Buffer.byteLength(output) > MODEL_CATALOG_LIMITS.maxBytes) throw new Error('Каталог моделей слишком большой.');
    const rows: CatalogRow[] = [];
    for (const raw of output.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line === 'Fetching available models...') continue;
      const separator = line.indexOf('\t');
      if (separator < 1) throw new Error('Неизвестный формат каталога Antigravity. Проверьте версию CLI или укажите модель вручную.');
      const id = line.slice(0, separator); const name = line.slice(separator + 1).trim();
      if (!/^[\w./:-]+$/.test(id) || !name || name.includes('\t') || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Некорректная строка каталога Antigravity.');
      rows.push({ id, name });
      if (rows.length > MODEL_CATALOG_LIMITS.maxModels) throw new Error('Каталог превышает лимит моделей.');
    }
    return rows;
  }
  private parse(text: string): CatalogRow {
    if (Buffer.byteLength(text) > MODEL_CATALOG_LIMITS.maxBytes) throw new Error('Каталог моделей слишком большой.');
    try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value as CatalogRow; } catch { /* do not expose response bodies */ }
    throw new Error('Провайдер вернул некорректный JSON каталога моделей.');
  }
  private async read(response: Response): Promise<string> {
    const reader = response.body?.getReader(); if (!reader) throw new Error('API вернул пустой ответ.');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > MODEL_CATALOG_LIMITS.maxBytes) throw new Error('Каталог моделей слишком большой.'); chunks.push(part.value);
    } return Buffer.concat(chunks).toString('utf8'); }
    catch { throw new Error('Не удалось прочитать каталог моделей: таймаут или превышен размер ответа.'); }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
