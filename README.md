# BladeVault Auth Backend

Cloudflare Worker backend for BladeVault authentication only.

This service is responsible for:

- Better Auth session management
- Google sign-in
- D1 auth/session storage
- popup auth handoff for local/container BladeVault clients
- issuing JWT backup tokens via Better Auth's JWT plugin

This service is **not** responsible for:

- knife CRUD
- image uploads
- backup file storage
- SQLite backup upload/download

Those responsibilities move to the Linux backup server.

## Routes

### Health / session

- `GET /`
- `GET /api/health`
- `GET /api/me`

### Better Auth

- `ALL /api/auth/*`
- `GET /api/auth/jwks`
- `GET /api/auth/token`

### Popup auth

- `GET /auth/popup/start?client_origin=...`
- `GET /auth/popup/complete?client_origin=...`

`/auth/popup/start` begins Google sign-in on the fixed auth domain.

`/auth/popup/complete` posts this payload back to the opener:

```json
{
  "type": "bladevault-auth-success",
  "accessToken": "<jwt for backup server>",
  "sessionToken": "<better-auth session token>",
  "expiresAt": "<iso timestamp>",
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "name": "Example User",
    "image": null
  }
}
```

Error payload:

```json
{
  "type": "bladevault-auth-error",
  "error": {
    "message": "Sign-in failed."
  }
}
```

## Config

All public URLs are env-driven.

### Worker vars

- `APP_NAME`
- `AUTH_PUBLIC_BASE_URL`
- `ALLOWED_CLIENT_ORIGINS`
- `COOKIE_DOMAIN`

### Worker secrets

- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- optional `BETTER_AUTH_API_KEY`

### Google OAuth

- Authorized JavaScript origin:
  - `AUTH_PUBLIC_BASE_URL`
- Redirect URI:
  - `${AUTH_PUBLIC_BASE_URL}/api/auth/callback/google`

## D1

This repo includes Better Auth base migrations plus JWT plugin key storage:

- `migrations/0000_better_auth.sql`
- `migrations/0002_better_auth_jwks.sql`

Apply migrations:

```bash
npx wrangler d1 migrations apply bladevault --local
npx wrangler d1 migrations apply bladevault --remote
```

## Local development

Install:

```bash
npm install
```

Run typecheck:

```bash
npm run typecheck
```

Generate Worker runtime types after config changes:

```bash
npm run cf-typegen
```

Run locally:

```bash
npm run dev
```

## Deploy

Set secrets:

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Deploy:

```bash
npm run deploy
```

## Docs

See:

- [docs/architecture.md](/Users/kolasokol/Code/bladevault-backend/docs/architecture.md)
- [docs/domain-migration-bladevault-pro.md](/Users/kolasokol/Code/bladevault-backend/docs/domain-migration-bladevault-pro.md)
- [docs/ubuntu-24-backup-server.md](/Users/kolasokol/Code/bladevault-backend/docs/ubuntu-24-backup-server.md)
- [docs/migration-to-linux-backup-server.md](/Users/kolasokol/Code/bladevault-backend/docs/migration-to-linux-backup-server.md)
