import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth } from './google-auth.js';
import { createApiServer } from './http-server.js';
import { createContainer } from '../bootstrap/container.js';
import { NodeSqliteDatabase } from '../db/node-sqlite-database.js';
import { SilentLogger } from '../core/logger.js';

const secret = 'test-session-secret-with-at-least-32-characters';
const owner = 'nikita.a.kalinin@gmail.com';
function signed(value: object): string {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}
test('Google gate denies anonymous and non-owner accounts before workspace access', async () => {
  let email = owner, verified = true, calls = 0;
  const auth = new GoogleAuth({ enabled: true, clientId: 'test-client', clientSecret: 'test-secret', sessionSecret: secret,
    redirectUri: 'https://nekitekat.online/tracker/api/auth/google/callback',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (String(input).includes('/token')) {
        assert.ok((init?.body as URLSearchParams).get('code_verifier'));
        return Response.json({ access_token: 'mock-token' });
      }
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer mock-token');
      return Response.json({ email, email_verified: verified, sub: 'google-user-id' });
    }) as typeof fetch });
  const app = createContainer({ config: { dbPath: ':memory:' }, db: new NodeSqliteDatabase({ file: ':memory:' }), logger: new SilentLogger() });
  const server = createApiServer(app, { auth });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: 'manual' });
  try {
    assert.deepEqual(await (await get('/api/auth/status')).json(), {
      enabled: true, configured: true, authenticated: false,
    });
    assert.match(await (await get('/')).text(), /https:\/\/t.me\/goodluck496/);
    for (const path of ['/api/tasks', '/api/workspaces', '/api/admin/backups', '/api/images/aaaaaaaa.png?workspace=default', '/api/automation/settings', '/api/health']) {
      const response = await get(path, { 'ngrok-auth-user-email': owner, 'X-Tracker-Workspace': 'default' });
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    for (const cookie of ['invalid', signed({ purpose: 'session', email: owner, sub: 'id', exp: 1 }),
      signed({ purpose: 'session', email: 'other@gmail.com', sub: 'id', exp: Date.now() / 1000 + 60 })]) {
      assert.equal((await get('/api/tasks', { Cookie: '__Host-sat_session=' + cookie })).status, 401);
    }
    assert.equal((await get('/api/auth/google/callback?code=abc&state=wrong')).status, 401);
    assert.equal(calls, 0);
    async function login() {
      const start = await get('/api/auth/google');
      const location = new URL(start.headers.get('location')!);
      assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(location.searchParams.get('redirect_uri'), 'https://nekitekat.online/tracker/api/auth/google/callback');
      assert.match(start.headers.getSetCookie()[0], /Secure; HttpOnly; SameSite=Lax/);
      return get('/api/auth/google/callback?code=abc&state=' + location.searchParams.get('state'), { Cookie: start.headers.getSetCookie()[0].split(';')[0] });
    }
    email = 'other@gmail.com';
    const denied = await login(); assert.equal(denied.status, 403);
    assert.match(await denied.text(), /goodluck496/);
    assert.ok(denied.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
    email = owner; verified = false; assert.equal((await login()).status, 401);
    verified = true;
    const allowed = await login(); assert.equal(allowed.status, 303);
    assert.equal(allowed.headers.get('location'), '/tracker/');
    const session = allowed.headers.getSetCookie().find(x => x.startsWith('__Host-sat_session='))!.split(';')[0];
    assert.equal((await get('/api/workspaces', { Cookie: session })).status, 200);
    const mutate = (origin?: string) => fetch(base + '/api/tasks', { method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ title: 'Owner task' }) });
    assert.equal((await mutate()).status, 403);
    assert.equal((await mutate('https://evil.example')).status, 403);
    assert.equal((await mutate('https://nekitekat.online')).status, 201);
    const logout = await fetch(base + '/api/auth/logout', { method: 'POST', redirect: 'manual', headers: { Cookie: session, Origin: 'https://nekitekat.online' } });
    assert.equal(logout.status, 303);
    assert.ok(logout.headers.getSetCookie().every(x => x.includes('Max-Age=0')));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); app.close(); }
});
test('missing or unsafe OAuth configuration fails closed', () => {
  for (const redirectUri of [undefined, 'http://example.com/api/auth/google/callback', 'https://example.com/invalid', 'https://example.com/api/auth/google/callback?x=y']) {
    assert.equal(new GoogleAuth({ redirectUri, clientId: 'id', clientSecret: 'secret', sessionSecret: secret }).configured, false);
  }
});

test('AUTH defaults to true, accepts true/false and rejects invalid values', () => {
  const previous = process.env.AUTH;
  try {
    delete process.env.AUTH;
    assert.equal(new GoogleAuth().enabled, true);
    for (const value of ['true', ' TRUE ']) {
      process.env.AUTH = value;
      assert.equal(new GoogleAuth().enabled, true);
    }
    for (const value of ['false', ' FALSE ']) {
      process.env.AUTH = value;
      assert.equal(new GoogleAuth().enabled, false);
    }
    for (const value of ['', '0', 'flase']) {
      process.env.AUTH = value;
      assert.throws(() => new GoogleAuth(), /AUTH must be true or false/);
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH;
    else process.env.AUTH = previous;
  }
});

test('AUTH=false serves UI and permits API reads and mutations without OAuth or cookies', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-no-auth-'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<html><base href="/"><body>Tracker UI</body></html>');
  const auth = new GoogleAuth({ enabled: false, clientId: undefined, clientSecret: undefined,
    sessionSecret: undefined, redirectUri: undefined });
  assert.equal(auth.configured, false);
  assert.equal(auth.basePath, '/');
  assert.equal(new GoogleAuth({ enabled: false,
    redirectUri: 'https://example.com/tracker/api/auth/google/callback' }).basePath, '/tracker/');
  const app = createContainer({ config: { dbPath: ':memory:', webDistDir: directory },
    db: new NodeSqliteDatabase({ file: ':memory:' }), logger: new SilentLogger() });
  const server = createApiServer(app, { auth });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ui = await fetch(base + '/');
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /<base href="\/">.*Tracker UI/);
    const status = await fetch(base + '/api/auth/status');
    assert.deepEqual(await status.json(), { enabled: false, configured: false, authenticated: false });
    for (const route of ['/api/health', '/api/workspaces', '/api/tasks', '/api/admin/backups', '/api/automation/settings']) {
      assert.equal((await fetch(base + route)).status, 200, route);
    }
    const created = await fetch(base + '/api/tasks', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'No login required' }) });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    assert.equal((await fetch(base + '/api/tasks/' + task.id, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Updated anonymously' }) })).status, 200);
    assert.equal((await fetch(base + '/api/tasks/' + task.id, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(base + '/api/tasks', { method: 'OPTIONS' })).status, 204);
    for (const route of ['/api/auth/google', '/api/auth/google/callback', '/api/auth/logout']) {
      const response = await fetch(base + route, { method: route.endsWith('logout') ? 'POST' : 'GET', redirect: 'manual' });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/');
      assert.equal(response.headers.get('set-cookie'), null);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('direct requests work under the configured base path even without nginx', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-base-path-'));
  fs.writeFileSync(path.join(directory, 'index.html'),
    '<html><base href="/"><script src="main-test.js" type="module"></script></html>');
  fs.writeFileSync(path.join(directory, 'main-test.js'), 'console.log("ok");');
  const auth = new GoogleAuth({ enabled: false,
    redirectUri: 'https://example.com/tracker/api/auth/google/callback' });
  assert.equal(auth.basePath, '/tracker/');
  const app = createContainer({ config: { dbPath: ':memory:', webDistDir: directory },
    db: new NodeSqliteDatabase({ file: ':memory:' }), logger: new SilentLogger() });
  const server = createApiServer(app, { auth });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Ассеты и API, запрошенные с префиксом base href, доходят до назначения.
    const asset = await fetch(base + '/tracker/main-test.js');
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'console.log("ok");');
    assert.equal((await fetch(base + '/tracker/api/health')).status, 200);
    const status = await fetch(base + '/tracker/api/auth/status');
    assert.deepEqual(await status.json(), { enabled: false, configured: false, authenticated: false });
    // Запросы без префикса (за nginx) работают как раньше.
    assert.equal((await fetch(base + '/api/health')).status, 200);
    // Похожий префикс не срезается и не попадает в API: отдаётся SPA-заглушка.
    const lookalike = await fetch(base + '/trackerfoo/api/health');
    assert.equal(lookalike.status, 200);
    assert.match(lookalike.headers.get('content-type') ?? '', /text\/html/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Google auth preserves item links and tabs, rejects external destinations, and normalizes proxy prefix', async () => {
  const auth = new GoogleAuth({
    enabled: true,
    clientId: 'test-client',
    clientSecret: 'test-secret',
    sessionSecret: secret,
    redirectUri: 'https://nekitekat.online/tracker/api/auth/google/callback',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/token')) {
        return Response.json({ access_token: 'mock-token' });
      }
      return Response.json({ email: owner, email_verified: true, sub: 'google-user-id' });
    }) as typeof fetch,
  });
  const app = createContainer({ config: { dbPath: ':memory:' }, db: new NodeSqliteDatabase({ file: ':memory:' }), logger: new SilentLogger() });
  const server = createApiServer(app, { auth });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: 'manual' });

  try {
    // 1. Direct hit on /item/SAT-62/plan?workspace=default (proxy stripped /tracker/)
    const promptProxy = await get('/item/SAT-62/plan?workspace=default');
    assert.equal(promptProxy.status, 200);
    const html1 = await promptProxy.text();
    assert.match(html1, /href="\/tracker\/api\/auth\/google\?returnTo=item%2FSAT-62%2Fplan%3Fworkspace%3Ddefault"/);

    // 2. Direct hit on /tracker/item/create?workspace=default
    const promptDirect = await get('/tracker/item/create?workspace=default');
    assert.equal(promptDirect.status, 200);
    const html2 = await promptDirect.text();
    assert.match(html2, /href="\/tracker\/api\/auth\/google\?returnTo=item%2Fcreate%3Fworkspace%3Ddefault"/);

    // 3. Complete login with returnTo for specific tab
    async function loginWithReturnTo(returnTo?: string, prefix = '') {
      const start = await get(prefix + '/api/auth/google' + (returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''));
      assert.equal(start.status, 303);
      const location = new URL(start.headers.get('location')!);
      const state = location.searchParams.get('state')!;
      const cookie = start.headers.getSetCookie()[0].split(';')[0];
      return get(`${prefix}/api/auth/google/callback?code=abc&state=${state}`, { Cookie: cookie });
    }

    // Tab return: /tracker/item/SAT-62/plan?workspace=default
    const resTab = await loginWithReturnTo('item/SAT-62/plan?workspace=default');
    assert.equal(resTab.status, 303);
    assert.equal(resTab.headers.get('location'), '/tracker/item/SAT-62/plan?workspace=default');

    // Create return: /tracker/item/create?workspace=default
    const resCreate = await loginWithReturnTo('item/create?workspace=default', '/tracker');
    assert.equal(resCreate.status, 303);
    assert.equal(resCreate.headers.get('location'), '/tracker/item/create?workspace=default');

    // Single prefix check when returnTo includes /tracker/
    const resPrefixed = await loginWithReturnTo('/tracker/item/SAT-62/questions');
    assert.equal(resPrefixed.status, 303);
    assert.equal(resPrefixed.headers.get('location'), '/tracker/item/SAT-62/questions');

    // Normal login without returnTo returns to basePath
    const resNormal = await loginWithReturnTo();
    assert.equal(resNormal.status, 303);
    assert.equal(resNormal.headers.get('location'), '/tracker/');

    // External or invalid destination rejected, returns to basePath
    const resEvil1 = await loginWithReturnTo('https://evil.example/phish');
    assert.equal(resEvil1.status, 303);
    assert.equal(resEvil1.headers.get('location'), '/tracker/');

    const resEvil2 = await loginWithReturnTo('//evil.example');
    assert.equal(resEvil2.status, 303);
    assert.equal(resEvil2.headers.get('location'), '/tracker/');

    const resInvalidTab = await loginWithReturnTo('item/SAT-62/invalid-tab');
    assert.equal(resInvalidTab.status, 303);
    assert.equal(resInvalidTab.headers.get('location'), '/tracker/');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.close();
  }
});
