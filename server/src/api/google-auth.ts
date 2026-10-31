import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './router.js';

const OWNER = 'nikita.a.kalinin@gmail.com';
const SESSION = '__Host-sat_session';
const STATE = '__Host-sat_oauth';
interface Signed { purpose: 'session' | 'oauth'; exp: number; email?: string; sub?: string; state?: string; verifier?: string }
export interface GoogleAuthOptions { clientId?: string; clientSecret?: string; sessionSecret?: string; redirectUri?: string; fetch?: typeof fetch }

/** Public HTTP entrypoint uses this gate before any workspace or file access. */
export class GoogleAuth {
  private readonly options: GoogleAuthOptions;
  public readonly basePath: string;
  constructor(options: GoogleAuthOptions = {}) {
    this.options = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      sessionSecret: process.env.AUTH_SESSION_SECRET, redirectUri: process.env.GOOGLE_REDIRECT_URI, ...options };
    this.basePath = this.redirectUrl()?.pathname.replace(/api\/auth\/google\/callback$/, '') || '/tracker/';
  }
  private redirectUrl(): URL | undefined {
    try {
      const url = new URL(this.options.redirectUri || '');
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        && /^\/(?:[a-zA-Z0-9_-]+\/)*api\/auth\/google\/callback$/.test(url.pathname)) return url;
    } catch { /* Missing configuration keeps access closed. */ }
    return undefined;
  }
  public get configured(): boolean {
    return Boolean(this.options.clientId?.trim() && this.options.clientSecret?.trim()
      && (this.options.sessionSecret?.length ?? 0) >= 32 && this.redirectUrl());
  }
  private equal(a: string, b: string): boolean {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  private sign(value: Signed): string {
    const data = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${data}.${createHmac('sha256', this.options.sessionSecret!).update(data).digest('base64url')}`;
  }
  private read(req: IncomingMessage, name: string, purpose: Signed['purpose']): Signed | undefined {
    if (!this.configured) return undefined;
    try {
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
      if (!cookie || cookie.length > 4096) return undefined;
      const [data, signature, extra] = cookie.slice(name.length + 1).split('.');
      if (!data || !signature || extra !== undefined || !this.equal(signature,
        createHmac('sha256', this.options.sessionSecret!).update(data).digest('base64url'))) return undefined;
      const value = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Signed;
      if (value.purpose === purpose && Number.isFinite(value.exp) && value.exp > Date.now() / 1000) return value;
    } catch { /* Reject malformed cookies. */ }
    return undefined;
  }
  private cookie(name: string, value: string, seconds: number): string {
    return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
  }
  private redirect(res: ServerResponse, target: string): void { res.writeHead(303, { Location: target }); res.end(); }
  public async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    const route = url.pathname;
    if (route === '/api/auth/status' && req.method === 'GET') {
      sendJson(res, 200, { configured: this.configured, authenticated: this.authenticated(req) }); return true;
    }
    if (route === '/api/auth/google' && req.method === 'GET') {
      if (!this.configured) { this.page(res, 503, 'Вход через Google пока не настроен.'); return true; }
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      res.setHeader('Set-Cookie', this.cookie(STATE, this.sign({ purpose: 'oauth', state, verifier, exp: Date.now() / 1000 + 600 }), 600));
      const params = new URLSearchParams({ client_id: this.options.clientId!, redirect_uri: this.options.redirectUri!,
        response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      this.redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`); return true;
    }
    if (route === '/api/auth/google/callback' && req.method === 'GET') {
      const saved = this.read(req, STATE, 'oauth');
      res.setHeader('Set-Cookie', [this.cookie(STATE, '', 0), this.cookie(SESSION, '', 0)]);
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      if (!saved?.state || !saved.verifier || !state || !this.equal(state, saved.state) || !code || code.length > 4096) {
        this.page(res, 401, 'Не удалось войти. Повторите вход через Google.'); return true;
      }
      try {
        const request = this.options.fetch ?? fetch;
        const tokenResponse = await request('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15000),
          body: new URLSearchParams({ code, client_id: this.options.clientId!, client_secret: this.options.clientSecret!,
            redirect_uri: this.options.redirectUri!, grant_type: 'authorization_code', code_verifier: saved.verifier }) });
        if (!tokenResponse.ok) throw new Error('Token exchange failed');
        const token = await tokenResponse.json() as { access_token?: string };
        if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Missing token');
        const profileResponse = await request('https://openidconnect.googleapis.com/v1/userinfo', {
          signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token.access_token}` } });
        if (!profileResponse.ok) throw new Error('Profile failed');
        const profile = await profileResponse.json() as { email?: string; email_verified?: boolean; sub?: string };
        if (profile.email_verified !== true || typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 255
          || typeof profile.email !== 'string') throw new Error('Unverified account');
        if (profile.email.toLowerCase() !== OWNER) { this.page(res, 403, 'Доступ к трекеру пока открыт только владельцу.'); return true; }
        res.setHeader('Set-Cookie', [this.cookie(STATE, '', 0), this.cookie(SESSION,
          this.sign({ purpose: 'session', email: OWNER, sub: profile.sub, exp: Date.now() / 1000 + 604800 }), 604800)]);
        this.redirect(res, this.basePath); return true;
      } catch { this.page(res, 401, 'Не удалось войти. Повторите вход через Google.'); return true; }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) {
      if (req.headers.origin !== this.redirectUrl()?.origin) {
        sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Invalid request origin.' } }); return true;
      }
    }
    if (route === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', [this.cookie(SESSION, '', 0), this.cookie(STATE, '', 0)]);
      this.redirect(res, this.basePath); return true;
    }
    if (this.authenticated(req)) return false;
    if (route.startsWith('/api/')) sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in with Google.' } });
    else this.page(res, 200, 'Войдите через Google, чтобы открыть трекер.');
    return true;
  }
  private authenticated(req: IncomingMessage): boolean {
    const session = this.read(req, SESSION, 'session');
    return session?.email === OWNER && typeof session.sub === 'string' && Boolean(session.sub);
  }
  private page(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simple AI Tracker — вход</title>
      <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:16px system-ui}main{margin:20px;padding:32px;max-width:440px;background:#1e293b;border-radius:18px}a{color:#7dd3fc}.login{display:block;padding:14px;background:#2563eb;color:white;text-align:center;border-radius:9px;text-decoration:none}p{line-height:1.6}</style>
      <main><h1>Simple AI Tracker</h1><p>${message}</p>${this.configured ? `<a class="login" href="${this.basePath}api/auth/google">Войти через Google</a>` : '<p>Вход через Google пока не настроен.</p>'}
      <p>Если хотите попробовать трекер — напишите в Telegram <a href="https://t.me/goodluck496" rel="noopener noreferrer">@goodluck496</a>.</p></main></html>`);
  }
}
