import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const MISSING_BUILD_PAGE = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Simple AI Tracker — UI не собран</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{max-width:640px;padding:32px;background:#1e293b;border-radius:16px}code{background:#0f172a;padding:2px 6px;border-radius:6px}</style></head>
<body><main>
<h1>Simple AI Tracker API работает</h1>
<p>Веб-интерфейс ещё не собран: каталог <code>dist/web/browser</code> отсутствует.</p>
<p>Соберите UI командой <code>npm run build:web</code> или запустите dev-сервер <code>npm run serve:web</code> (порт 4318 с проксированием /api на 4317).</p>
<p>API доступен: <code>/api/health</code>, <code>/api/tasks</code>, <code>/api/tags</code>.</p>
</main></body></html>`;

/** Раздача собранного веб-клиента с fallback на index.html (SPA). */
export class StaticFileServer {
  public constructor(private readonly rootDir: string) {}

  public get available(): boolean {
    return fs.existsSync(path.join(this.rootDir, 'index.html'));
  }

  public serve(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (!this.available) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MISSING_BUILD_PAGE);
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolved = path.resolve(this.rootDir, relative);
    const isInsideRoot = resolved.startsWith(path.resolve(this.rootDir));

    if (isInsideRoot && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      this.streamFile(res, resolved);
      return;
    }

    // SPA-роут или отсутствующий ассет: отдаём index.html только для навигации.
    if (!path.extname(relative)) {
      this.streamFile(res, path.join(this.rootDir, 'index.html'));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  private streamFile(res: ServerResponse, filePath: string): void {
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] ?? 'application/octet-stream';
    const isHtml = extension === '.html';
    const stat = fs.statSync(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
    });

    if (isHtml) {
      res.end(fs.readFileSync(filePath));
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  }
}
