# Tracker Google OAuth

Only verified Google email nikita.a.kalinin@gmail.com can sign in. Other accounts receive 403 and https://t.me/goodluck496. Existing workspaces are unchanged. Local stdio MCP and workers do not use browser sessions.

Copy .env.auth.example to .env.auth. Set Google Web application client ID and secret, and a separate random AUTH_SESSION_SECRET with at least 32 characters. Preserve it across restarts. Secrets are excluded from Git and Docker context.

Register this exact Authorized redirect URI in Google Console:
https://nekitekat.online/tracker/api/auth/google/callback

For Testing applications add the owner as a test user.
Run docker compose config --quiet, then docker compose up -d --build simple-ai-tracker.
Open https://nekitekat.online/tracker/ . HTTPS is required.

Nginx already strips /tracker/ and forwards to port 4317. Root /api/ remains CRM. HTML base href is derived from callback URL; browser API calls, image previews and downloads use /tracker/api/.

The production HTTP entrypoint always enables GoogleAuth. The lower-level createApiServer accepts an optional gate for local tests. Missing OAuth configuration keeps production closed. All application APIs including health, images, backups and automation require sessions. /api/auth/status only returns configuration/session booleans. Mutations require the configured HTTPS Origin. Proxy email headers are not identities.

Authorization Code flow uses PKCE S256, signed state and verified Google userinfo. Separate __Host-sat_session cookie uses Secure, HttpOnly, SameSite=Lax, Path=/ and HMAC-SHA256; lifetime seven days. OAuth cookie lifetime is ten minutes. Google tokens stay on the server. Logout clears cookies. Images use private no-store caching.

After deployment verify anonymous API denial, forged headers, owner login, other-account denial, image previews, backup downloads and logout. Mocked OAuth tests do not prove real Google Console configuration.
