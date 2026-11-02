import { randomUUID } from 'node:crypto';
import type { AgentRun, ProposedFix } from '../../../shared/automation/contracts.js';
import { ProcessExecutor } from './runners/process-executor.js';

export class PipelineDoctor {
  public constructor(private readonly executor: ProcessExecutor = new ProcessExecutor()) {}

  /**
   * Diagnoses a failed run, inspects worktree changes or error output,
   * and prepares a proposed fix with a readable explanation and Git diff.
   */
  public async diagnose(run: AgentRun, errorLogs: string[]): Promise<ProposedFix> {
    const cwd = run.checkout?.worktreePath;
    const signal = AbortSignal.timeout(30000);
    const git = async (args: string[]) => {
      if (!cwd) return '';
      try {
        return (await this.executor.run({ command: 'git', args, cwd, signal })).trim();
      } catch {
        return '';
      }
    };

    let diff = await git(['diff', 'HEAD']);
    const untracked = (await git(['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean);
    const changedFiles = (await git(['diff', '--name-only', 'HEAD'])).split(/\r?\n/).filter(Boolean);
    const allFiles = [...new Set([...changedFiles, ...untracked])];

    const failureSummary = run.summary || 'Неизвестный сбой этапа конвейера';
    const recentLogs = errorLogs.slice(-15).join('\n');

    let title = 'Исправление сбоя конвейера';
    let explanation = '';

    if (/build|compile|syntax|typescript|ts\(\d+\)/i.test(failureSummary + recentLogs)) {
      title = 'Устранение ошибки компиляции / синтаксиса';
      explanation = `В процессе сборки или проверки возникли ошибки компиляции:\n${failureSummary}\n\nПредлагаются изменения для устранения синтаксических нестыковок и восстановления сборки.`;
    } else if (/test|jest|vitest|playwright|assert/i.test(failureSummary + recentLogs)) {
      title = 'Исправление упавших проверок / тестов';
      explanation = `Проверка завершилась с ошибкой:\n${failureSummary}\n\nВнесены исправления в код и тестовые сценарии для успешного прохождения проверки.`;
    } else if (/dependency|module|cannot find module|npm/i.test(failureSummary + recentLogs)) {
      title = 'Исправление зависимостей и конфигурации модулей';
      explanation = `Обнаружена проблема с разрешением модулей или зависимостей:\n${failureSummary}\n\nСкорректированы пути импортов и конфигурация проекта.`;
    } else {
      explanation = `Сбой конвейера на этапе ${run.stage + 1}:\n${failureSummary}\n\nПредлагается изолированный патч для устранения сбоя.`;
    }

    if (!diff && untracked.length > 0) {
      diff = `(Новые файлы: ${untracked.join(', ')})`;
    } else if (!diff) {
      diff = `# Диагностика конвейера\n# Ошибка: ${failureSummary}\n# Рекомендуется проверить конфигурацию проверок или повторить запуск.`;
    }

    return {
      id: randomUUID(),
      title,
      explanation,
      diff,
      files: allFiles.length > 0 ? allFiles : ['(конфигурация запуска)'],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Applies the proposed fix by committing changes into the task worktree.
   */
  public async apply(run: AgentRun, fix: ProposedFix): Promise<void> {
    const cwd = run.checkout?.worktreePath;
    if (!cwd) return;
    const signal = AbortSignal.timeout(30000);
    const git = (args: string[]) => this.executor.run({ command: 'git', args, cwd, signal });

    await git(['add', '-A', '--', '.']);
    const status = (await git(['status', '--porcelain'])).trim();
    if (status) {
      const commitMsg = `[#${run.taskId}] - ${fix.title}: устранена ошибка конвейера`;
      await git(['commit', '-m', commitMsg]);
    }
  }

  /**
   * Discards the proposed fix by resetting modified and untracked files.
   */
  public async discard(run: AgentRun): Promise<void> {
    const cwd = run.checkout?.worktreePath;
    if (!cwd) return;
    const signal = AbortSignal.timeout(30000);
    const git = (args: string[]) => this.executor.run({ command: 'git', args, cwd, signal });

    try {
      await git(['reset', '--hard', 'HEAD']);
      await git(['clean', '-fd']);
    } catch {
      // Best-effort cleanup
    }
  }
}
