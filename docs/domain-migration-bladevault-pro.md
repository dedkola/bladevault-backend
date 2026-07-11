# BladeVault Domain Migration To `bladevault.pro`

This is the concrete domain mapping for your current production setup:

- app: `https://bladevault.pro`
- auth Worker: `https://auth.bladevault.pro`
- backup API: `https://backup.bladevault.pro`

If your frontend will live on another subdomain like `https://app.bladevault.pro`,
keep the auth and backup domains above and add that frontend origin anywhere the
checklist below mentions allowed origins.

## 1. DNS

Create or update these records:

- `auth.bladevault.pro`
  - point it to the Cloudflare Worker custom domain route
- `backup.bladevault.pro`
  - point it to the Ubuntu backup server public IP
- `bladevault.pro`
  - point it to the frontend host
- optional `www.bladevault.pro`
  - point it to the same frontend host or redirect it to `bladevault.pro`

## 2. Caddy On The Ubuntu Backup Server

Update `/etc/caddy/Caddyfile`:

```caddy
backup.bladevault.pro {
  reverse_proxy 127.0.0.1:8080
}
```

Then reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 3. Backup Server Env

Update `/opt/bladevault-backup-server/.env`:

```env
BACKUP_PUBLIC_BASE_URL=https://backup.bladevault.pro
AUTH_JWT_ISSUER=https://auth.bladevault.pro
AUTH_JWT_AUDIENCE=https://auth.bladevault.pro
AUTH_JWKS_URL=https://auth.bladevault.pro/api/auth/jwks
BACKUP_STORAGE_ROOT=/var/lib/bladevault-backups
MAX_BACKUP_SIZE_MB=0
ALLOWED_CLIENT_ORIGINS=https://bladevault.pro,https://*.bladevault.pro,http://localhost:*,http://127.0.0.1:*
HOST=127.0.0.1
PORT=8080
NODE_ENV=production
```

Restart after changing it:

```bash
sudo systemctl restart bladevault-backup-server
sudo systemctl status bladevault-backup-server --no-pager
```

## 4. Cloudflare Worker And Wrangler

This repo now uses:

- route: `auth.bladevault.pro`
- `AUTH_PUBLIC_BASE_URL=https://auth.bladevault.pro`
- `COOKIE_DOMAIN=.bladevault.pro`
- `ALLOWED_CLIENT_ORIGINS=https://bladevault.pro,https://*.bladevault.pro,http://localhost:*,http://127.0.0.1:*`

Deploy the Worker after DNS is ready:

```bash
npm run deploy
```

## 5. Google OAuth

In Google Cloud Console, update the OAuth client used by Better Auth.

Set:

- Authorized JavaScript origins
  - `https://auth.bladevault.pro`
- Authorized redirect URIs
  - `https://auth.bladevault.pro/api/auth/callback/google`

If your frontend itself is also registered as an origin in the same OAuth client,
replace old `tkweb` entries there too.

## 6. Better Auth

Better Auth in this repo reads the domain from env, so the important settings are:

- `AUTH_PUBLIC_BASE_URL=https://auth.bladevault.pro`
- optional `COOKIE_DOMAIN=.bladevault.pro`

What this affects:

- Better Auth base URL
- Google callback URL generation
- JWT issuer
- JWT audience
- popup auth completion URL

If you use Better Auth Dash or any external Better Auth dashboard/project settings,
replace any old `tkweb` domain references there too.

## 7. Frontend Env

Wherever the frontend stores backend URLs, update them to:

```env
NEXT_PUBLIC_BLADEVAULT_AUTH_URL=https://auth.bladevault.pro
NEXT_PUBLIC_BLADEVAULT_BACKUP_URL=https://backup.bladevault.pro
```

If the frontend is hosted on `bladevault.pro`, its browser origin should also be
included in:

- Worker `ALLOWED_CLIENT_ORIGINS`
- backup server `ALLOWED_CLIENT_ORIGINS`

## 8. Cloudflare Secrets And External Services

These values usually stay the same, but they are worth checking during a domain move:

- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- optional `BETTER_AUTH_API_KEY`

Also review:

- Cloudflare Worker custom domain attachment
- Cloudflare DNS records
- any firewall rules that only allow the old hostnames

## 9. Validation Checklist

Run these checks after the move:

```bash
curl https://auth.bladevault.pro/api/health
curl https://auth.bladevault.pro/api/auth/jwks
curl -I https://backup.bladevault.pro/health
```

Then test in the app:

1. Google sign-in popup opens on `auth.bladevault.pro`
2. sign-in completes and returns to the app
3. `GET /api/me` works
4. backup upload works
5. backup restore works

## 10. Old Domain Cleanup

After the new domain works end-to-end, remove old `tkweb.site` and `tkweb.dev`
entries from:

- Caddy
- Google OAuth origins and redirect URIs
- Cloudflare Worker routes
- frontend env files
- backup server env files
- any deployment notes or secrets manager entries that still document the old domains
