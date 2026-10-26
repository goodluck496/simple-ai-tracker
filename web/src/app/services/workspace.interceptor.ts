import type { HttpInterceptorFn } from '@angular/common/http';

export const WORKSPACE_STORAGE_KEY = 'sat.workspace';

/** Each tab keeps its own selection; all requests carry an explicit workspace. */
export const workspaceInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request);
  const name = sessionStorage.getItem(WORKSPACE_STORAGE_KEY) ?? 'default';
  return next(request.clone({ setHeaders: { 'X-Tracker-Workspace': name } }));
};
