# Migration To Linux Backup Server

This guide moves BladeVault from the old Worker-heavy backup approach to the
current split architecture:

- Cloudflare Worker for auth only
- Ubuntu server for backup storage

## Migration Goal

After migration:

- `auth.example.com` stays on Cloudflare Worker
- `backup.example.com` points to Ubuntu
- frontend sign-in still uses Google popup auth
- backup and restore use the Linux server directly

## Before You Start

Confirm these are ready:

- Cloudflare Worker deployed and reachable on the auth domain
- D1 auth migrations applied
- Ubuntu server reachable by SSH
- DNS control for the backup domain
- frontend configured with auth and backup URLs

## Step 1. Keep The Auth Worker

Do not remove the Worker.

The Worker still owns:

- Google OAuth
- Better Auth sessions
- popup sign-in
- JWKS publishing
- JWT token issuance for the backup server

Quick checks:

```bash
curl https://auth.example.com/api/health
curl https://auth.example.com/api/auth/jwks
```

Expected:

- both return `200`

## Step 2. Prepare Ubuntu Paths

Create the required directories:

```bash
sudo mkdir -p /opt/bladevault-backup-server
sudo mkdir -p /var/lib/bladevault-backups
sudo chown -R bladevault:bladevault /opt/bladevault-backup-server
sudo chown -R bladevault:bladevault /var/lib/bladevault-backups
sudo chmod 750 /var/lib/bladevault-backups
```

Final path map:

- app directory: `/opt/bladevault-backup-server`
- backup archive storage: `/var/lib/bladevault-backups`
- env file: `/opt/bladevault-backup-server/.env`
- systemd unit: `/etc/systemd/system/bladevault-backup-server.service`
- Caddyfile: `/etc/caddy/Caddyfile`

## Step 3. Copy Backup Server Files

Copy these files from this repo to `/opt/bladevault-backup-server`:

- [backup-server/server.js](../backup-server/server.js)
- [backup-server/package.json](../backup-server/package.json)
- [backup-server/package-lock.json](../backup-server/package-lock.json)
- [backup-server/bladevault-backup-server.service.example](../backup-server/bladevault-backup-server.service.example)

Then install runtime dependencies:

```bash
cd /opt/bladevault-backup-server
npm ci --omit=dev
```

## Step 4. Create The Backup Server Env File

Create `/opt/bladevault-backup-server/.env`:

```env
BACKUP_PUBLIC_BASE_URL=https://backup.example.com
AUTH_JWT_ISSUER=https://auth.example.com
AUTH_JWT_AUDIENCE=https://auth.example.com
AUTH_JWKS_URL=https://auth.example.com/api/auth/jwks
BACKUP_STORAGE_ROOT=/var/lib/bladevault-backups
MAX_BACKUP_SIZE_MB=0
ALLOWED_CLIENT_ORIGINS=*
HOST=127.0.0.1
PORT=8080
NODE_ENV=production
```

Notes:

- `AUTH_JWT_AUDIENCE` should match the Worker JWT audience
- `BACKUP_STORAGE_ROOT` should stay on persistent disk
- `MAX_BACKUP_SIZE_MB=0` disables the app-level upload limit
- `ALLOWED_CLIENT_ORIGINS=*` allows any browser origin

## Step 5. Install The systemd Service

Install the service file:

```bash
sudo cp /opt/bladevault-backup-server/bladevault-backup-server.service.example /etc/systemd/system/bladevault-backup-server.service
sudo systemctl daemon-reload
sudo systemctl enable bladevault-backup-server
sudo systemctl start bladevault-backup-server
```

Verify:

```bash
sudo systemctl status bladevault-backup-server --no-pager
curl http://127.0.0.1:8080/health
```

Expected:

- service is `active (running)`
- localhost health returns `200`

## Step 6. Configure Caddy

Example `/etc/caddy/Caddyfile`:

```caddy
backup.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Then validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Public check:

```bash
curl -I https://backup.example.com/health
```

Expected:

- `HTTP/2 200`

## Step 7. Point DNS To Ubuntu

Update DNS so:

- `backup.example.com` resolves to the Ubuntu server public IP

Recommended:

- keep Cloudflare only on the auth Worker domain
- send backup traffic directly to Ubuntu

## Step 8. Update Frontend Runtime Env

The frontend should use:

```env
NEXT_PUBLIC_BLADEVAULT_AUTH_URL=https://auth.example.com
NEXT_PUBLIC_BLADEVAULT_BACKUP_URL=https://backup.example.com
```

If frontend runs in Docker, make sure these vars are passed at container start.

## Step 9. Verify End-To-End

Run these checks in order:

1. Sign in through Google popup
2. Confirm session refresh works
3. Run `Backup Local -> Cloud`
4. Confirm backup files exist on Ubuntu
5. Run `Restore Cloud -> Local`

Check stored files:

```bash
sudo find /var/lib/bladevault-backups -maxdepth 3 -type f | sort
```

Expected new format:

- `latest.tar.gz`
- `metadata.json`
- history `*.tar.gz`

## Step 10. Handle Old Backup Files

Older test runs may have files like:

- `latest.sqlite`
- `history/*.sqlite`

These belong to the old SQLite-only backup format.

Important:

- the new backup server writes `tar.gz`
- the new frontend restore flow expects `tar.gz`
- old `.sqlite` backup files are not auto-converted

Safe cleanup plan:

1. complete a fresh `tar.gz` backup successfully
2. confirm restore works from that new backup
3. archive or delete the old `.sqlite` backup files manually

Example review:

```bash
sudo find /var/lib/bladevault-backups -maxdepth 3 -type f | sort
```

## Step 11. Optional Cleanup Of Old Cloud Paths

After Linux backup is working, you can remove old storage flows that are no
longer used.

Examples:

- old Worker upload routes
- old R2 image backup logic
- obsolete env vars for storage paths that no longer exist

Do not delete D1 auth data unless you explicitly intend to reset auth users and
sessions.

## Rollback Plan

If the migration fails:

1. keep the auth Worker deployed
2. keep the Ubuntu files in place
3. point the frontend back to the last working backup URL if needed
4. inspect:
   - `sudo systemctl status bladevault-backup-server`
   - `sudo journalctl -u bladevault-backup-server -n 200 --no-pager`
   - `sudo journalctl -u caddy -n 200 --no-pager`

## Troubleshooting

### `curl https://backup.example.com/health` returns `502`

Usually one of these:

- Node service is not running
- Caddy is proxying to the wrong port
- app crashed during startup

Check:

```bash
curl http://127.0.0.1:8080/health
sudo systemctl status bladevault-backup-server --no-pager
```

### Browser says auth or backup URL is not configured

Usually one of these:

- frontend env vars are missing
- Docker container was started without runtime env

Check the frontend runtime env:

- `NEXT_PUBLIC_BLADEVAULT_AUTH_URL`
- `NEXT_PUBLIC_BLADEVAULT_BACKUP_URL`

### Backup upload fails

Check:

- auth token issuance from `auth.example.com/api/auth/token`
- Caddy HTTPS on the backup domain
- backup server logs
- free disk space under `/var/lib/bladevault-backups`

## Related Docs

- [docs/architecture.md](architecture.md)
- [docs/ubuntu-24-backup-server.md](ubuntu-24-backup-server.md)
