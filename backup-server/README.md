# BladeVault Backup Server

Minimal Node.js backup API for Ubuntu 24.

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
- `ALLOWED_CLIENT_ORIGINS`
  - comma-separated browser origins or wildcard patterns
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
