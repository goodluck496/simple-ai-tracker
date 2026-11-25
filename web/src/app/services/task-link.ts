import { inject, Injectable } from '@angular/core';
import { Router, UrlTree } from '@angular/router';
import { WorkspaceService } from './workspace.service';

export type DialogTab = 'overview' | 'plan' | 'questions' | 'discussion' | 'relations';
export const DIALOG_TABS: readonly DialogTab[] = ['overview', 'plan', 'questions', 'discussion', 'relations'] as const;

export function isDialogTab(value: unknown): value is DialogTab {
  return typeof value === 'string' && (DIALOG_TABS as readonly string[]).includes(value);
}

export function resolveDefaultTab(task?: { openQuestionsCount?: number; questions?: unknown } | null): DialogTab {
  if (!task) return 'overview';
  if (typeof task.openQuestionsCount === 'number') {
    return task.openQuestionsCount > 0 ? 'questions' : 'overview';
  }
  if (Array.isArray(task.questions)) {
    return task.questions.some((q: { answer?: string | null }) => !q.answer || !q.answer.trim()) ? 'questions' : 'overview';
  }
  const openList = (task.questions as { open?: readonly unknown[] } | undefined)?.open;
  if (Array.isArray(openList)) {
    return openList.length > 0 ? 'questions' : 'overview';
  }
  return 'overview';
}

@Injectable({ providedIn: 'root' })
export class TaskLinkService {
  private readonly router = inject(Router);
  private readonly workspace = inject(WorkspaceService);

  public taskTree(taskId: string, tab?: DialogTab | null, workspace?: string | null): UrlTree {
    const ws = workspace ?? this.workspace.current();
    const commands = tab ? ['item', taskId, tab] : ['item', taskId];
    return this.router.createUrlTree(commands, {
      queryParams: ws ? { workspace: ws } : undefined,
    });
  }

  public createTree(workspace?: string | null): UrlTree {
    const ws = workspace ?? this.workspace.current();
    return this.router.createUrlTree(['item', 'create'], {
      queryParams: ws ? { workspace: ws } : undefined,
    });
  }

  public boardTree(workspace?: string | null): UrlTree {
    const ws = workspace ?? this.workspace.current();
    return this.router.createUrlTree(['/'], {
      queryParams: ws ? { workspace: ws } : undefined,
    });
  }

  public navigateToTask(
    taskId: string,
    tab?: DialogTab | null,
    options?: { replaceUrl?: boolean; workspace?: string | null; state?: unknown },
  ): Promise<boolean> {
    const tree = this.taskTree(taskId, tab, options?.workspace);
    return this.router.navigateByUrl(tree, {
      replaceUrl: options?.replaceUrl,
      state: options?.state as object,
    });
  }

  public navigateToCreate(
    options?: { replaceUrl?: boolean; workspace?: string | null; state?: unknown },
  ): Promise<boolean> {
    const tree = this.createTree(options?.workspace);
    return this.router.navigateByUrl(tree, {
      replaceUrl: options?.replaceUrl,
      state: options?.state as object,
    });
  }

  public navigateToBoard(
    options?: { replaceUrl?: boolean; workspace?: string | null },
  ): Promise<boolean> {
    const tree = this.boardTree(options?.workspace);
    return this.router.navigateByUrl(tree, { replaceUrl: options?.replaceUrl });
  }

  public parseItemPath(pathAndQuery: string): { type: 'create'; workspace: string | null } | { type: 'task'; id: string; rawTab: string | null; validTab: DialogTab | null; workspace: string | null } | null {
    const [pathPart, queryPart] = pathAndQuery.split('?');
    const query = new URLSearchParams(queryPart ?? '');
    const ws = query.get('workspace');
    const segments = pathPart.replace(/^\/+/, '').split('/');
    if (segments[0] !== 'item') return null;
    if (segments[1] === 'create') return { type: 'create', workspace: ws };
    const id = segments[1];
    if (!id) return null;
    const rawTab = segments[2] || null;
    const validTab = isDialogTab(rawTab) ? rawTab : null;
    return { type: 'task', id, rawTab, validTab, workspace: ws };
  }
}
