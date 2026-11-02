import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentRun, ProposedFix, ModelConnection } from '../../../shared/automation/contracts.js';
import { ProviderKind } from '../../../shared/automation/contracts.js';
import { ProcessExecutor } from './runners/process-executor.js';

export class PipelineDoctor {
  public constructor(
    private readonly executor: ProcessExecutor = new ProcessExecutor(),
    private readonly request: typeof fetch = fetch
  ) {}

  /**
   * Diagnoses a failed run, inspects worktree changes or error output,
   * consults local Ollama or configured Doctor model when available,
   * and prepares a proposed fix with a readable explanation and Git diff.
   */
  public async diagnose(run: AgentRun, errorLogs: string[]): Promise<ProposedFix> {
    const wtCwd = run.checkout?.worktreePath;
    const repoCwd = run.settings?.repositoryPath;

    const git = async (cwd: string | undefined, args: string[]) => {
      if (!cwd) return '';
      try {
        const signal = AbortSignal.timeout(15000);
        return (await this.executor.run({ command: 'git', args, cwd, signal })).trim();
      } catch {
        return '';
      }
    };

    // 1. Gather worktree changes
    const wtDiff = await git(wtCwd, ['diff', 'HEAD']);
    const wtUntracked = (await git(wtCwd, ['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean);
    const wtChangedFiles = (await git(wtCwd, ['diff', '--name-only', 'HEAD'])).split(/\r?\n/).filter(Boolean);
    const wtAllFiles = [...new Set([...wtChangedFiles, ...wtUntracked])];

    // 2. Gather repository changes
    const repoStatus = await git(repoCwd, ['status', '--porcelain']);
    const repoBranch = await git(repoCwd, ['branch', '--show-current']);
    const repoDiff = await git(repoCwd, ['diff', 'HEAD']);
    const repoUntracked = (await git(repoCwd, ['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean);
    const repoChangedFiles = (await git(repoCwd, ['diff', '--name-only', 'HEAD'])).split(/\r?\n/).filter(Boolean);
    const repoAllFiles = [...new Set([...repoChangedFiles, ...repoUntracked])];

    const failureSummary = run.summary || 'Неизвестный сбой этапа конвейера';
    const recentLogs = errorLogs.slice(-20).join('\n');
    const combinedLog = `${failureSummary}\n${recentLogs}`;

    // 3. Detect known deterministic failure patterns
    const isCleanCheckoutError = /clean target checkout|dirty target|requires a clean/i.test(combinedLog) ||
      (run.settings?.mergePolicy === 'local' && Boolean(repoStatus) && !wtCwd);
    const isBranchError = /target branch must be checked out|not on target branch/i.test(combinedLog);
    const isBuildError = /build|compile|syntax|typescript|ts\(\d+\)/i.test(combinedLog);
    const isTestError = /test|jest|vitest|playwright|assert/i.test(combinedLog);
    const isDepError = /dependency|module|cannot find module|npm/i.test(combinedLog);

    // Default rule-based diagnosis
    let title = 'Исправление сбоя конвейера';
    let explanation = '';
    let scope: 'worktree' | 'repository' = 'worktree';
    let action: 'commit_dirty_repo' | 'patch_code' | 'switch_branch' | 'retry_stage' = 'patch_code';
    let files: string[] = [];
    let diff = '';

    if (isCleanCheckoutError) {
      scope = 'repository';
      action = 'commit_dirty_repo';
      title = 'Сохранение локальных файлов и подготовка репозитория';
      files = repoAllFiles.length > 0 ? repoAllFiles : ['(локальные изменения репозитория)'];
      const fileListStr = files.slice(0, 15).map(f => `  • ${f}`).join('\n');
      explanation = `Автоматическая интеграция требует чистого состояния рабочей ветки в основном репозитории.\n\nОбнаружены несохранённые или новые файлы в репозитории (${files.length} шт.):\n${fileListStr}${files.length > 15 ? '\n  • ...' : ''}\n\nПрименение авто-исправления автоматически закоммитит эти изменения как рабочий прогресс (WIP) перед запуском конвейера, чтобы освободить ветку для безопасной интеграции.`;
      if (repoDiff) {
        diff = repoDiff;
      } else if (repoUntracked.length > 0) {
        diff = repoUntracked.map(f => `+ ${f} (новый неотслеживаемый файл)`).join('\n');
      } else {
        diff = `(Несохранённые локальные файлы в рабочем репозитории: ${files.join(', ')})`;
      }
    } else if (isBranchError) {
      scope = 'repository';
      action = 'switch_branch';
      title = `Переключение на базовую ветку ${run.settings?.baseBranch || 'main'}`;
      files = [`ветка: ${run.settings?.baseBranch || 'main'}`];
      diff = `(Текущая ветка: ${repoBranch || 'неизвестно'} -> переключение на ${run.settings?.baseBranch || 'main'})`;
      explanation = `Для автоматического слияния требуется, чтобы в основном репозитории была активна базовая ветка ${run.settings?.baseBranch || 'main'}. Применение исправления переключит активную ветку.`;
    } else if (isBuildError) {
      scope = 'worktree';
      action = 'patch_code';
      title = 'Устранение ошибки компиляции / синтаксиса';
      explanation = `В процессе сборки или проверки возникли ошибки компиляции:\n${failureSummary}\n\nПредлагаются изменения для устранения синтаксических нестыковок и восстановления сборки.`;
      files = wtAllFiles.length > 0 ? wtAllFiles : ['(исходный код)'];
      diff = wtDiff || (wtUntracked.length > 0 ? wtUntracked.map(f => `+ ${f}`).join('\n') : '(Ошибки компиляции зафиксированы в журнале)');
    } else if (isTestError) {
      scope = 'worktree';
      action = 'patch_code';
      title = 'Исправление упавших проверок / тестов';
      explanation = `Проверка завершилась с ошибкой:\n${failureSummary}\n\nВнесены исправления в код и тестовые сценарии для успешного прохождения проверки.`;
      files = wtAllFiles.length > 0 ? wtAllFiles : ['(тесты)'];
      diff = wtDiff || (wtUntracked.length > 0 ? wtUntracked.map(f => `+ ${f}`).join('\n') : '(Сбой тестовых проверок зафиксирован в журнале)');
    } else if (isDepError) {
      scope = 'worktree';
      action = 'patch_code';
      title = 'Исправление зависимостей и конфигурации модулей';
      explanation = `Обнаружена проблема с разрешением модулей или зависимостей:\n${failureSummary}\n\nСкорректированы пути импортов и конфигурация проекта.`;
      files = wtAllFiles.length > 0 ? wtAllFiles : ['package.json'];
      diff = wtDiff || '(Требуется установка или обновление зависимостей)';
    } else {
      files = wtAllFiles.length > 0 ? wtAllFiles : (repoAllFiles.length > 0 ? repoAllFiles : ['(конфигурация запуска)']);
      diff = wtDiff || (wtUntracked.length > 0 ? wtUntracked.map(f => `+ ${f}`).join('\n') : (repoDiff || '(Изменений в кодовой базе не обнаружено)'));
      explanation = `Сбой конвейера на этапе ${run.stage + 1}:\n${failureSummary}\n\nПредлагается изолированный патч для устранения сбоя.`;
    }

    // 4. Try to consult configured LLM / local Ollama model for intelligent diagnosis
    let modelBadge: string | undefined;
    const connection = this.resolveConnection(run);
    if (connection) {
      const model = this.resolveModel(run, connection);
      try {
        const aiAdvice = await this.consultModel(
          connection,
          model,
          run,
          recentLogs,
          repoStatus,
          repoAllFiles,
          wtDiff,
          wtAllFiles
        );

        if (aiAdvice) {
          modelBadge = `${connection.label || connection.id} (${model})`;
          if (aiAdvice.title) title = aiAdvice.title;
          if (aiAdvice.explanation) explanation = aiAdvice.explanation;
          // Do not override clean checkout repository scope if repo is dirty
          if (!isCleanCheckoutError && aiAdvice.scope) {
            scope = aiAdvice.scope;
          }
          if (!isCleanCheckoutError && aiAdvice.action) {
            action = aiAdvice.action;
          }
        }
      } catch {
        // Graceful fallback to rule-based diagnosis on connection timeout or offline host
      }
    }

    return {
      id: randomUUID(),
      title,
      explanation,
      diff,
      files,
      scope,
      action,
      ...(modelBadge ? { model: modelBadge } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Applies the proposed fix by committing changes into the task worktree or main repository.
   */
  public async apply(run: AgentRun, fix: ProposedFix): Promise<void> {
    const signal = AbortSignal.timeout(30000);

    // 1. Repository-level fix (e.g. dirty main checkout blocking local merge)
    if (fix.scope === 'repository' || fix.action === 'commit_dirty_repo') {
      const cwd = run.settings?.repositoryPath;
      if (cwd) {
        const git = (args: string[]) => this.executor.run({ command: 'git', args, cwd, signal });
        await git(['add', '-A', '--', '.']);
        const status = (await git(['status', '--porcelain'])).trim();
        if (status) {
          const commitMsg = `[#${run.taskId}] - WIP: сохранение локальных изменений перед запуском конвейера`;
          await git(['commit', '-m', commitMsg]);
        }
      }
    }

    if (fix.action === 'switch_branch') {
      const cwd = run.settings?.repositoryPath;
      if (cwd && run.settings?.baseBranch) {
        const git = (args: string[]) => this.executor.run({ command: 'git', args, cwd, signal });
        await git(['checkout', run.settings.baseBranch]);
      }
    }

    // 2. Worktree-level fix
    const wtCwd = run.checkout?.worktreePath;
    if (wtCwd && (fix.scope === 'worktree' || !fix.scope)) {
      const git = (args: string[]) => this.executor.run({ command: 'git', args, cwd: wtCwd, signal });
      await git(['add', '-A', '--', '.']);
      const status = (await git(['status', '--porcelain'])).trim();
      if (status) {
        const commitMsg = `[#${run.taskId}] - ${fix.title}: устранена ошибка конвейера`;
        await git(['commit', '-m', commitMsg]);
      }
    }
  }

  /**
   * Discards the proposed fix by resetting modified and untracked files.
   */
  public async discard(run: AgentRun, fix?: ProposedFix | null): Promise<void> {
    const signal = AbortSignal.timeout(30000);
    const targetFix = fix || run.proposedFix;

    if (targetFix?.scope === 'repository') {
      const repoCwd = run.settings?.repositoryPath;
      if (repoCwd) {
        try {
          await this.executor.run({ command: 'git', args: ['reset', 'HEAD'], cwd: repoCwd, signal });
        } catch {
          // Best-effort
        }
      }
    }

    const wtCwd = run.checkout?.worktreePath;
    if (wtCwd) {
      try {
        await this.executor.run({ command: 'git', args: ['reset', '--hard', 'HEAD'], cwd: wtCwd, signal });
        await this.executor.run({ command: 'git', args: ['clean', '-fd'], cwd: wtCwd, signal });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  private resolveBaseUrl(rawBase: string): string {
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

  private resolveConnection(run: AgentRun): ModelConnection | undefined {
    const connections = run.settings?.connections || [];
    // 1. Doctor agent profile connection
    if (run.settings?.doctorAgent?.connectionId) {
      const matched = connections.find(c => c.id === run.settings.doctorAgent!.connectionId);
      if (matched) return matched;
    }
    // 2. Explicit doctorConnectionId if set
    if (run.settings?.doctorConnectionId) {
      const matched = connections.find(c => c.id === run.settings.doctorConnectionId);
      if (matched) return matched;
    }
    // 3. Local model or Ollama
    const local = connections.find(c => c.isLocal || c.kind === ProviderKind.Ollama);
    if (local) return local;
    // 4. Any API connection with baseUrl
    return connections.find(c => Boolean(c.baseUrl));
  }

  private resolveModel(run: AgentRun, connection: ModelConnection): string {
    if (run.settings?.doctorAgent?.model?.trim()) {
      return run.settings.doctorAgent.model.trim();
    }
    if (run.settings?.doctorModel?.trim()) {
      return run.settings.doctorModel.trim();
    }
    const agentUsingConn = run.settings?.agents?.find(a => a.connectionId === connection.id && a.model?.trim());
    if (agentUsingConn?.model) {
      return agentUsingConn.model.trim();
    }
    return 'qwen2.5-coder:latest';
  }

  private resolveInstructions(run: AgentRun): string {
    if (run.settings?.doctorAgent?.instructions?.trim()) {
      return run.settings.doctorAgent.instructions.trim();
    }
    return 'Ты — системный агент Pipeline Doctor, эксперт по диагностике и автоматическому устранению сбоев в CI/CD конвейере и работе агентов.';
  }

  private async consultModel(
    connection: ModelConnection,
    model: string,
    run: AgentRun,
    errorContext: string,
    repoStatus: string,
    repoFiles: string[],
    worktreeDiff: string,
    worktreeFiles: string[]
  ): Promise<{ title?: string; explanation?: string; scope?: 'worktree' | 'repository'; action?: 'commit_dirty_repo' | 'patch_code' | 'switch_branch' | 'retry_stage' } | null> {
    const rawBase = connection.baseUrl?.replace(/\/$/, '');
    if (!rawBase) return null;
    const base = this.resolveBaseUrl(rawBase);
    const url = `${base}${connection.kind === ProviderKind.Ollama && !base.endsWith('/v1') ? '/v1' : ''}/chat/completions`;
    const secret = connection.credentialEnv ? process.env[connection.credentialEnv] : undefined;
    if (connection.credentialEnv && !secret) return null;

    const prompt = [
      this.resolveInstructions(run),
      `Задача: ${run.taskId}`,
      `Ошибка: ${run.summary || 'Неизвестная ошибка'}`,
      `Журнал последних ошибок:\n${errorContext || '(нет дополнительных записей журнала)'}`,
      `Состояние основного репозитория (git status):\n${repoStatus || '(чисто)'}`,
      repoFiles.length ? `Файлы основного репозитория с изменениями: ${repoFiles.slice(0, 20).join(', ')}` : '',
      worktreeDiff ? `Git diff рабочей ветки (worktree):\n${worktreeDiff.slice(0, 3000)}` : '',
      worktreeFiles.length ? `Файлы рабочей ветки: ${worktreeFiles.slice(0, 20).join(', ')}` : '',
      '',
      'Проанализируй причину сбоя и предложи оптимальное действие для возобновления конвейера.',
      'Верни СТРОГО один валидный JSON-объект без разметки Markdown и без лишнего текста:',
      '{',
      '  "title": "Краткое название исправления на русском (до 70 символов)",',
      '  "explanation": "Подробный разбор причины сбоя и что исправить (на русском языке)",',
      '  "scope": "repository" или "worktree",',
      '  "action": "commit_dirty_repo" или "patch_code" или "switch_branch" или "retry_stage"',
      '}'
    ].filter(Boolean).join('\n\n');

    const signal = AbortSignal.timeout(60000);
    const response = await this.request(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: this.resolveInstructions(run) + ' Отвечай только JSON-объектом с полями title, explanation, scope, action.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const rawText = data?.choices?.[0]?.message?.content?.trim();
    if (!rawText) return null;

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    return {
      title: typeof parsed.title === 'string' ? parsed.title.trim() : undefined,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim() : undefined,
      scope: parsed.scope === 'repository' || parsed.scope === 'worktree' ? parsed.scope : undefined,
      action: ['commit_dirty_repo', 'patch_code', 'switch_branch', 'retry_stage'].includes(parsed.action as string)
        ? (parsed.action as 'commit_dirty_repo' | 'patch_code' | 'switch_branch' | 'retry_stage')
        : undefined,
    };
  }
}
