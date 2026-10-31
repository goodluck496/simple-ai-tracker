import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
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
  const auth = new GoogleAuth({ clientId: 'test-client', clientSecret: 'test-secret', sessionSecret: secret,
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
