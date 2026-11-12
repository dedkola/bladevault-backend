# BladeVault Backend Architecture

This repository contains the two backend services used by BladeVault cloud backup:

1. `bladevault-backend`
   Cloudflare Worker for auth only
2. `backup-server/`
   Node.js backup API for Ubuntu 24

The frontend talks to both services directly:

- auth domain: `https://auth.example.com`
- backup domain: `https://backup.example.com`

## Design Rationale

App data and image work used to run through the Worker, which caused CPU
pressure and was the wrong place for large uploads.

The current design separates responsibilities:

- the Worker handles Google sign-in, Better Auth sessions, and JWT issuance
- the Linux backup server stores the uploaded backup archive on disk
- the frontend uploads the full local `data/` folder as `tar.gz`

## Service Responsibilities

### Auth Worker

The Worker is responsible for:

- Better Auth session management
- Google OAuth
- D1-backed auth tables
- popup auth flow for local and containerized frontends
- JWT issuance for the backup server
- JWKS publishing for backup token verification

The Worker is not responsible for:

- knife CRUD
- image uploads
- backup file storage
- archive download and restore

Relevant routes:

- `GET /`
- `GET /api/health`
- `GET /api/me`
- `ALL /api/auth/*`
- `GET /api/auth/jwks`
- `GET /api/auth/token`
- `GET /auth/popup/start?client_origin=...`
- `GET /auth/popup/complete?client_origin=...`

### Linux Backup Server

The Ubuntu service is responsible for:

- verifying JWTs from the auth Worker
- receiving `tar.gz` backup uploads
- storing one latest backup plus history per user
- serving backup metadata
- serving the latest backup for restore

Relevant routes:

- `GET /health`
- `GET /backup/meta`
- `GET /backup/history`
- `PUT /backup/latest`
- `GET /backup/latest`

## Request Flow

### Sign-in flow

1. Frontend opens `https://auth.example.com/auth/popup/start?client_origin=...`
2. Worker starts Google sign-in through Better Auth
3. Google returns to `https://auth.example.com/auth/popup/complete?...`
4. Worker loads the Better Auth session
5. Worker issues a JWT backup token
6. Worker posts the auth payload back to the opener window

Popup success payload:

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

### Backup flow

1. Frontend exports the local `data/` folder to `tar.gz`
2. Frontend asks `auth.example.com/api/auth/token` for a fresh JWT
3. Frontend uploads the archive to `backup.example.com/backup/latest`
4. Linux verifies the JWT using the auth Worker JWKS
5. Linux stores:
   - `latest.tar.gz`
   - `metadata.json`
   - history copy in `history/`

### Restore flow

1. Frontend requests `backup.example.com/backup/latest`
2. Linux verifies the JWT and returns the latest archive
3. Frontend replaces its local `data/` folder with the restored archive

## Storage Layout

### Cloudflare

- Worker code: this repo
- auth/session database: D1
- Better Auth JWT keys: D1 `jwks` table

### Ubuntu

Application files:

- app root: `/opt/bladevault-backup-server`
- env file: `/opt/bladevault-backup-server/.env`
- systemd unit: `/etc/systemd/system/bladevault-backup-server.service`
- Caddy config: `/etc/caddy/Caddyfile`

Backup storage:

- storage root: `/var/lib/bladevault-backups`
- per-user layout:

```text
/var/lib/bladevault-backups/<userId>/
  latest.tar.gz
  metadata.json
  history/
    2026-06-27T11-00-00-000Z.tar.gz
```

## Configuration Surface

### Worker env vars

- `APP_NAME`
- `AUTH_PUBLIC_BASE_URL`
- `ALLOWED_CLIENT_ORIGINS`
- `COOKIE_DOMAIN`

### Worker secrets

- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- optional `BETTER_AUTH_API_KEY`
- optional `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`

### Backup server env

- `BACKUP_PUBLIC_BASE_URL`
- `AUTH_JWT_ISSUER`
- `AUTH_JWT_AUDIENCE`
- `AUTH_JWKS_URL`
- `BACKUP_STORAGE_ROOT`
- `MAX_BACKUP_SIZE_MB`
- `ALLOWED_CLIENT_ORIGINS`
- `HOST`
- `PORT`
- optional `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`

Current semantics:

- `MAX_BACKUP_SIZE_MB=0` (or `off`/`none`/`unlimited`) means no app-level upload cap
- `ALLOWED_CLIENT_ORIGINS=*` means allow every browser origin

## Operational Notes

- The Worker should stay on Cloudflare custom domain routing only
- The backup API should run on Ubuntu behind Caddy
- The backup API should listen on `127.0.0.1:8080`
- Public DNS for the backup API should point to the Linux server
- Browser uploads should go to the Linux server directly, not through the Worker

## Related Docs

- [README.md](../README.md)
- [docs/ubuntu-24-backup-server.md](ubuntu-24-backup-server.md)
