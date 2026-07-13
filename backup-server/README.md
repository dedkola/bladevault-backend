# BladeVault Backup Server

Minimal Node.js backup API for Ubuntu 24.

The server stores the uploaded BladeVault `data/` folder as a `tar.gz` archive per user.

## Routes

- `GET /health`
- `GET /backup/meta`
- `GET /backup/history`
- `PUT /backup/latest`
- `GET /backup/latest`

## Required env

- `BACKUP_PUBLIC_BASE_URL`
- `AUTH_JWT_ISSUER`
- `AUTH_JWKS_URL`
- `BACKUP_STORAGE_ROOT`

## Optional env

- `AUTH_JWT_AUDIENCE`
  - defaults to `AUTH_JWT_ISSUER`
- `MAX_BACKUP_SIZE_MB`
  - defaults to `50`
  - set to `0`, `none`, or `unlimited` to disable the app-level size cap
- `ALLOWED_CLIENT_ORIGINS`
  - comma-separated browser origins or wildcard patterns
  - set to `*` to allow every browser origin
- `HOST`
  - defaults to `127.0.0.1`
- `PORT`
  - defaults to `8080`

## Local run

```bash
cp .env.example .env
npm install
npm run start
```

## Ubuntu deploy

Copy these files into `/opt/bladevault-backup-server`:

- `package.json`
- `package-lock.json`
- `server.js`
- `.env`
- `bladevault-backup-server.service.example`
- `scripts/cleanup-backup-history.sh`

Then:

```bash
cd /opt/bladevault-backup-server
npm ci --omit=dev
```

The service should listen on `127.0.0.1:8080` and stay behind Caddy.

To install the service file:

```bash
sudo cp bladevault-backup-server.service.example /etc/systemd/system/bladevault-backup-server.service
sudo systemctl daemon-reload
sudo systemctl enable bladevault-backup-server
sudo systemctl start bladevault-backup-server
```

## Backup retention cron (keep latest 10)

`scripts/cleanup-backup-history.sh` removes old files from each user's
`history/` folder and keeps only the newest 10 `.tar.gz` copies. It does not
touch `latest.tar.gz`.

Install script:

```bash
cd /opt/bladevault-backup-server
mkdir -p scripts
cp /path/to/repo/backup-server/scripts/cleanup-backup-history.sh scripts/
chmod 750 scripts/cleanup-backup-history.sh
```

Test in dry-run mode:

```bash
BACKUP_STORAGE_ROOT=/var/lib/bladevault-backups \
  /opt/bladevault-backup-server/scripts/cleanup-backup-history.sh --dry-run --keep 10
```

Set daily cron at 03:30:

```bash
sudo crontab -e
```

```cron
30 3 * * * BACKUP_STORAGE_ROOT=/var/lib/bladevault-backups /opt/bladevault-backup-server/scripts/cleanup-backup-history.sh --keep 10 >> /var/log/bladevault-backup-retention.log 2>&1
```

If you install the cron under a non-root user, change the log path to a file
that user can write. Otherwise the shell redirection can fail before the script
even starts
