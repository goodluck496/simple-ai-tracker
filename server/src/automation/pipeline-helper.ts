import fs from 'node:fs';
import type { AutomationSettings, ModelConnection } from '../../../shared/automation/contracts.js';
import { ProviderKind } from '../../../shared/automation/contracts.js';
import { CommitMessage } from '../../../shared/automation/commit-message.js';

export class PipelineHelper {
  public static resolveOllamaConnection(settings?: AutomationSettings): { connection: ModelConnection; model: string } | null {
    if (!settings?.connections?.length) return null;
    const local = settings.connections.find(c => c.isLocal || c.kind === ProviderKind.Ollama);
    if (!local || !local.baseUrl) return null;

    const model = settings.doctorAgent?.model?.trim()
      || settings.doctorModel?.trim()
      || settings.agents?.find(a => a.connectionId === local.id && a.model?.trim())?.model?.trim()
      || 'qwen3:8b';

    return { connection: local, model };
  }

  public static resolveBaseUrl(rawBase: string): string {
    const base = rawBase.replace(/\/$/, '');
    try {
      if (fs.existsSync('/.dockerenv')) {
        return base.replace(/\b(localhost|127\.0\.0\.1)\b/g, 'host.docker.internal');
      }
    } catch {
      // ignore
    }
    return base;
  }

  /**
   * Summarizes raw error output (build, tests, compiler) into a concise diagnostic summary.
   * If local Ollama is reachable, requests a 3-8 line extraction of affected files and errors.
   * Otherwise falls back to deterministic regex extraction of key failure lines.
   */
  public static async compressErrorLog(
    rawText: string,
    settings?: AutomationSettings,
    request: typeof fetch = fetch
  ): Promise<string> {
    if (!rawText || rawText.trim().length <= 400) {
      return (rawText || '').trim();
    }

    const deterministic = this.extractKeyErrors(rawText);

    const ollama = this.resolveOllamaConnection(settings);
    if (!ollama) {
      return deterministic;
    }

    try {
      const base = this.resolveBaseUrl(ollama.connection.baseUrl!);
      const url = `${base}${ollama.connection.kind === ProviderKind.Ollama && !base.endsWith('/v1') ? '/v1' : ''}/chat/completions`;
      const secret = ollama.connection.credentialEnv ? process.env[ollama.connection.credentialEnv] : undefined;

      const signal = AbortSignal.timeout(10000);
      const response = await request(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({
          model: ollama.model,
          messages: [
            {
              role: 'system',
              content: 'Ты — ассистент конвейера CI/CD. Выдели из лога сборки/теста только суть ошибки: файлы, строки, код ошибки (TS, SyntaxError, fail), и краткое описание проблемы. Не пиши советов по исправлению. Ответ строго до 10 строк на русском или английском.'
            },
            {
              role: 'user',
              content: `Лог сбоя:\n${rawText.slice(-6000)}`
            }
          ],
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const summary = data?.choices?.[0]?.message?.content?.trim();
        if (summary && summary.length > 20 && summary.length < 1500) {
          return summary;
        }
      }
    } catch {
      // Fallback to deterministic extraction on timeout or offline Ollama
    }

    return deterministic;
  }

  /**
   * Deterministically filters error logs for lines matching failure indicators.
   */
  public static extractKeyErrors(raw: string): string {
    const lines = raw.split(/\r?\n/);
    const errorLines: string[] = [];
    const pattern = /\b(error|failed|failure|exception|TS\d+|syntaxerror|referenceerror|typeerror|assertionerror|FAIL|assert)\b/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (pattern.test(line)) {
        errorLines.push(line);
        if (lines[i + 1] && lines[i + 1].trim() && !pattern.test(lines[i + 1]) && lines[i + 1].length < 200) {
          errorLines.push(`  ${lines[i + 1].trim()}`);
          i++;
        }
        if (errorLines.length >= 25) break;
      }
    }

    if (errorLines.length > 0) {
      return errorLines.slice(0, 25).join('\n').slice(0, 2500);
    }
    return raw.trim().slice(-1500);
  }

  /**
   * Repairs or generates a valid Russian commit message according to CommitMessage rules.
   */
  public static async repairCommitMessage(
    rawMessage: unknown,
    taskId: string,
    taskTitle: string,
    diffStat: string = '',
    settings?: AutomationSettings,
    request: typeof fetch = fetch
  ): Promise<string> {
    // 1. Check if already valid
    try {
      return CommitMessage.validate(rawMessage, taskId);
    } catch {
      // Proceed to repair
    }

    // 2. Try Ollama if available
    const ollama = this.resolveOllamaConnection(settings);
    if (ollama) {
      try {
        const base = this.resolveBaseUrl(ollama.connection.baseUrl!);
        const url = `${base}${ollama.connection.kind === ProviderKind.Ollama && !base.endsWith('/v1') ? '/v1' : ''}/chat/completions`;
        const secret = ollama.connection.credentialEnv ? process.env[ollama.connection.credentialEnv] : undefined;

        const signal = AbortSignal.timeout(8000);
        const response = await request(url, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({
            model: ollama.model,
            messages: [
              {
                role: 'system',
                content: `Сформируй одну строку коммита Git строго по шаблону:
[#${taskId}] - <краткое описание изменений на русском>, чтобы <цель задачи на русском>
Обязательно используй слово "чтобы" или "для". Строго одна строка, без кавычек и markdown.`
              },
              {
                role: 'user',
                content: `Задача: ${taskId} - ${taskTitle}\nЧерновик: ${String(rawMessage || '')}\nDiff: ${diffStat.slice(0, 500)}`
              }
            ],
            temperature: 0.1
          })
        });

        if (response.ok) {
          const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          const candidate = data?.choices?.[0]?.message?.content?.trim().replace(/^['"`]+|['"`]+$/g, '');
          if (candidate) {
            try {
              return CommitMessage.validate(candidate, taskId);
            } catch {
              // Ignore invalid LLM output and fall back
            }
          }
        }
      } catch {
        // Fallback to deterministic template
      }
    }

    // 3. Fallback to forTask (which produces guaranteed valid message)
    return CommitMessage.forTask(rawMessage, taskId, taskTitle);
  }
}
