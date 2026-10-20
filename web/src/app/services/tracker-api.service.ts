import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, of, throwError } from 'rxjs';
import type {
  BackupListResponse,
  BackupRecord,
  CreateTaskPayload,
  LinkRelation,
  QuestionPhase,
  Tag,
  TaskCard,
  TaskComment,
  TaskFilters,
  TaskQuestion,
  TaskSummary,
  TrackerMeta,
  UpdateTaskPayload,
} from '../models/tracker.models';

/** Базовый URL API: в собранном приложении — тот же origin, в dev — через proxy. */
const API_BASE = '/api';

interface TaskListResponse {
  readonly tasks: readonly TaskSummary[];
  readonly total: number;
}

interface TaskResponse {
  readonly task: TaskCard;
}

@Injectable({ providedIn: 'root' })
export class TrackerApiService {
  private readonly http = inject(HttpClient);

  public getMeta(): Observable<TrackerMeta> {
    return this.http.get<TrackerMeta>(`${API_BASE}/meta`);
  }

  public getHealth(): Observable<{ status: string; app: string; version: string; tasks: number }> {
    return this.http.get<{ status: string; app: string; version: string; tasks: number }>(`${API_BASE}/health`);
  }

  public listTasks(filters: TaskFilters): Observable<TaskListResponse> {
    let params = new HttpParams();
    if (filters.status) params = params.set('status', filters.status);
    if (filters.type) params = params.set('type', filters.type);
    if (filters.tag) params = params.set('tag', filters.tag);
    if (filters.parentId) params = params.set('parentId', filters.parentId);
    if (filters.query) params = params.set('q', filters.query);
    if (filters.scopes && filters.scopes.length > 0) params = params.set('scope', filters.scopes.join(','));
    return this.http.get<TaskListResponse>(`${API_BASE}/tasks`, { params });
  }

  public getTask(id: string): Observable<TaskResponse> {
    return this.http.get<TaskResponse>(`${API_BASE}/tasks/${encodeURIComponent(id)}`);
  }

  public createTask(payload: CreateTaskPayload): Observable<TaskResponse> {
    return this.http.post<TaskResponse>(`${API_BASE}/tasks`, payload);
  }

  public updateTask(id: string, payload: UpdateTaskPayload): Observable<TaskResponse> {
    return this.http.patch<TaskResponse>(`${API_BASE}/tasks/${encodeURIComponent(id)}`, payload);
  }

  public deleteTask(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${API_BASE}/tasks/${encodeURIComponent(id)}`);
  }

  public setStatus(id: string, status: string, comment?: string): Observable<TaskResponse> {
    return this.http.post<TaskResponse>(`${API_BASE}/tasks/${encodeURIComponent(id)}/status`, { status, comment });
  }

  public moveTask(
    id: string,
    target: { status?: string; beforeId?: string; afterId?: string; toIndex?: number },
  ): Observable<TaskResponse> {
    return this.http.post<TaskResponse>(`${API_BASE}/tasks/${encodeURIComponent(id)}/move`, target);
  }

  public addComment(id: string, text: string, author = 'User'): Observable<{ comment: TaskComment }> {
    return this.http.post<{ comment: TaskComment }>(`${API_BASE}/tasks/${encodeURIComponent(id)}/comments`, {
      text,
      author,
    });
  }

  public askQuestions(
    id: string,
    questions: readonly string[],
    phase: QuestionPhase = 'planning',
  ): Observable<{ task: TaskCard; questions: readonly TaskQuestion[] }> {
    return this.http.post<{ task: TaskCard; questions: readonly TaskQuestion[] }>(
      `${API_BASE}/tasks/${encodeURIComponent(id)}/questions`,
      { questions, phase },
    );
  }

  public deleteQuestion(taskId: string, questionId: number): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(
      `${API_BASE}/tasks/${encodeURIComponent(taskId)}/questions/${questionId}`,
    );
  }

  public answerQuestion(id: string, questionId: number, answer: string): Observable<{ task: TaskCard }> {
    return this.http.post<{ task: TaskCard }>(
      `${API_BASE}/tasks/${encodeURIComponent(id)}/questions/${questionId}/answer`,
      { answer, answeredBy: 'User' },
    );
  }

  public attachPlan(
    id: string,
    payload: {
      readonly content: string;
      readonly name?: string;
      readonly summary?: string;
      readonly questions?: readonly string[];
      readonly statusMode?: 'auto' | 'none';
    },
  ): Observable<{ task: TaskCard }> {
    return this.http.post<{ task: TaskCard }>(`${API_BASE}/tasks/${encodeURIComponent(id)}/plan`, payload);
  }

  public recordClarification(
    id: string,
    payload: {
      readonly clarification: string;
      readonly reason?: string;
      readonly impact?: string;
      readonly planChanged?: boolean;
      readonly questions?: readonly string[];
    },
  ): Observable<{ task: TaskCard }> {
    return this.http.post<{ task: TaskCard }>(
      `${API_BASE}/tasks/${encodeURIComponent(id)}/clarifications`,
      payload,
    );
  }

  public addAttachment(
    id: string,
    payload: { readonly name: string; readonly content: string; readonly kind?: 'plan' | 'report' | 'file' },
  ): Observable<unknown> {
    return this.http.post(`${API_BASE}/tasks/${encodeURIComponent(id)}/attachments`, payload);
  }

  public linkTasks(id: string, linkedTaskId: string, relation: LinkRelation = 'related'): Observable<TaskResponse> {
    return this.http.post<TaskResponse>(`${API_BASE}/tasks/${encodeURIComponent(id)}/links`, {
      linkedTaskId,
      relation,
    });
  }

  public unlinkTasks(id: string, linkedTaskId: string): Observable<TaskResponse> {
    return this.http.delete<TaskResponse>(
      `${API_BASE}/tasks/${encodeURIComponent(id)}/links/${encodeURIComponent(linkedTaskId)}`,
    );
  }

  public listTags(): Observable<{ tags: readonly Tag[] }> {
    return this.http.get<{ tags: readonly Tag[] }>(`${API_BASE}/tags`);
  }

  public addTag(name: string, color?: string, description?: string): Observable<{ tag: Tag }> {
    return this.http.post<{ tag: Tag }>(`${API_BASE}/tags`, { name, color, description });
  }

  public deleteTag(name: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${API_BASE}/tags/${encodeURIComponent(name)}`);
  }

  public getStats(): Observable<{ total: number; byStatus: Record<string, number>; tags: number }> {
    return this.http.get<{ total: number; byStatus: Record<string, number>; tags: number }>(`${API_BASE}/stats`);
  }

  /** Загрузка скриншота: data-URL → лёгкая ссылка /api/images/<файл>. */
  public uploadImage(dataUrl: string): Observable<{ url: string; fileName: string; size: number }> {
    return this.http.post<{ url: string; fileName: string; size: number }>(`${API_BASE}/images`, { dataUrl });
  }

  /** Удаление вложения карточки. */
  public deleteAttachment(taskId: string, attachmentId: number): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(
      `${API_BASE}/tasks/${encodeURIComponent(taskId)}/attachments/${attachmentId}`,
    );
  }

  /** Markdown-инструкция для ИИ-агента (AGENT_INSTRUCTIONS.md). */
  public getInstructions(): Observable<string> {
    return this.http.get(`${API_BASE}/instructions`, { responseType: 'text' });
  }

  public listBackups(): Observable<BackupListResponse> {
    return this.http.get<BackupListResponse>(`${API_BASE}/admin/backups`);
  }

  public createBackup(): Observable<{ backup: BackupRecord; removedByRotation: number; keep: number }> {
    return this.http.post<{ backup: BackupRecord; removedByRotation: number; keep: number }>(
      `${API_BASE}/admin/backup`,
      {},
    );
  }

  public deleteBackup(name: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${API_BASE}/admin/backups/${encodeURIComponent(name)}`);
  }

  public backupDownloadUrl(name: string): string {
    return `${API_BASE}/admin/backups/${encodeURIComponent(name)}/download`;
  }

  /** Извлекает сообщение об ошибке API для показа пользователю. */
  public static describeError(error: unknown): string {
    const maybeHttp = error as { error?: { error?: { message?: string } }; message?: string };
    return maybeHttp?.error?.error?.message ?? maybeHttp?.message ?? 'Неизвестная ошибка';
  }

  public safe<T>(source: Observable<T>): Observable<T | null> {
    return source.pipe(
      catchError((error: unknown) => {
        console.error('[Simple AI Tracker] Ошибка запроса', error);
        return of(null);
      }),
    );
  }

  public fail<T>(source: Observable<T>): Observable<T> {
    return source.pipe(catchError((error: unknown) => throwError(() => error)));
  }
}
