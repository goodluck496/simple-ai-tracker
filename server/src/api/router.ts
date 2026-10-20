import type { IncomingMessage, ServerResponse } from 'node:http';
import { TrackerError } from '../core/errors.js';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export type RouteHandler = (context: RouteContext) => Promise<void> | void;

interface RouteRecord {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** Минималистичный роутер: без внешних зависимостей, с параметрами пути. */
export class Router {
  private readonly routes: RouteRecord[] = [];

  public add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: path.split('/').filter(Boolean),
      handler,
    });
  }

  public get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  public post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  public patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler);
  }

  public delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  public match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const requestSegments = pathname.split('/').filter(Boolean);
    const upperMethod = method.toUpperCase();

    for (const route of this.routes) {
      if (route.method !== upperMethod) continue;
      if (route.segments.length !== requestSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const pattern = route.segments[index];
        const value = requestSegments[index];
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(value);
          continue;
        }
        if (pattern !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const found = this.match(req.method ?? 'GET', url.pathname);
    if (!found) return false;

    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readJsonBody(req);
      await found.handler({
        req,
        res,
        url,
        params: found.params,
        query: url.searchParams,
        body,
      });
    } catch (error) {
      if (error instanceof TrackerError) {
        sendJson(res, error.httpStatus, { error: error.toJSON() });
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: { code: 'INTERNAL', message } });
    }
    return true;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new TrackerError('VALIDATION_FAILED', 'Слишком большое тело запроса.');
    }
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TrackerError('VALIDATION_FAILED', 'Тело запроса не является корректным JSON.');
  }
}

/** Типизированное чтение поля из тела запроса. */
export function bodyField<T>(body: unknown, key: string): T | undefined {
  if (!body || typeof body !== 'object') return undefined;
  return (body as Record<string, unknown>)[key] as T | undefined;
}

export function requireBodyField<T>(body: unknown, key: string): T {
  const value = bodyField<T>(body, key);
  if (value === undefined || value === null || value === '') {
    throw new TrackerError('VALIDATION_FAILED', `Поле "${key}" обязательно.`);
  }
  return value;
}
