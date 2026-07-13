# Ubuntu 24 Backup Server Setup

This is the step-by-step server setup guide for the BladeVault Linux backup API.

Use this when you want to provision a fresh Ubuntu 24 host for:

- `https://backup.example.com`

The auth Worker stays on Cloudflare and is documented separately in:

- [docs/architecture.md](architecture.md)
- [README.md](../README.md)

## What This Server Does

The Ubuntu server stores the uploaded BladeVault `data/` folder as a `tar.gz`
archive per authenticated user.

Routes:

- `GET /health`
- `GET /backup/meta`
- `GET /backup/history`
- `PUT /backup/latest`
- `GET /backup/latest`

## Required Paths

These are the expected final paths on the Ubuntu server:

- app root: `/opt/bladevault-backup-server`
- backup storage root: `/var/lib/bladevault-backups`
- backup env file: `/opt/bladevault-backup-server/.env`
- systemd unit: `/etc/systemd/system/bladevault-backup-server.service`
- Caddy config: `/etc/caddy/Caddyfile`

## 1. Prerequisites

- Ubuntu 24
- public DNS control for `backup.example.com`
- SSH access
- one auth Worker domain already working, for example `https://auth.example.com`

## 2. Create Service User

```bash
sudo adduser bladevault
sudo usermod -aG sudo bladevault
```

Install the SSH public key:

```bash
sudo mkdir -p /home/bladevault/.ssh
sudo chmod 700 /home/bladevault/.ssh
sudo nano /home/bladevault/.ssh/authorized_keys
sudo chmod 600 /home/bladevault/.ssh/authorized_keys
sudo chown -R bladevault:bladevault /home/bladevault/.ssh
```

## 3. Harden SSH

Edit:

```bash
sudo nano /etc/ssh/sshd_config
```

Recommended minimum settings:

- `PasswordAuthentication no`
- `PermitRootLogin no`

Restart SSH:

```bash
sudo systemctl restart ssh
```

## 4. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## 5. Install Packages

```bash
sudo apt update
sudo apt install -y curl git ufw debian-keyring debian-archive-keyring apt-transport-https
```

Install Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Install Caddy:

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## 6. Create Directories

```bash
sudo mkdir -p /opt/bladevault-backup-server
sudo mkdir -p /var/lib/bladevault-backups
sudo chown -R bladevault:bladevault /opt/bladevault-backup-server
sudo chown -R bladevault:bladevault /var/lib/bladevault-backups
sudo chmod 750 /var/lib/bladevault-backups
```

Expected storage layout:

```text
/var/lib/bladevault-backups/
  <userId>/
    latest.tar.gz
    metadata.json
    history/
      2026-06-27T11-00-00-000Z.tar.gz
```

## 7. Point DNS

Point:

- `backup.example.com`

to the Ubuntu server public IP.

Recommended:

- keep the auth domain on Cloudflare Worker routing
- keep the backup domain pointed straight to Ubuntu

## 8. Copy App Files

Copy these files from this repo to `/opt/bladevault-backup-server`:

- [backup-server/server.js](../backup-server/server.js)
- [backup-server/package.json](../backup-server/package.json)
- [backup-server/package-lock.json](../backup-server/package-lock.json)
- [backup-server/scripts/cleanup-backup-history.sh](../backup-server/scripts/cleanup-backup-history.sh)
- [backup-server/.env.example](../backup-server/.env.example)
- [backup-server/bladevault-backup-server.service.example](../backup-server/bladevault-backup-server.service.example)

Install dependencies:

```bash
cd /opt/bladevault-backup-server
npm ci --omit=dev
```

## 9. Create `/opt/bladevault-backup-server/.env`

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

Meaning:

- `BACKUP_PUBLIC_BASE_URL`
  public backup API domain
- `AUTH_JWT_ISSUER`
  auth Worker JWT issuer
- `AUTH_JWT_AUDIENCE`
  should match the Worker JWT audience
- `AUTH_JWKS_URL`
  public JWKS endpoint from the auth Worker
- `BACKUP_STORAGE_ROOT`
  persistent backup storage directory
- `MAX_BACKUP_SIZE_MB=0`
  disables app-level upload limit
- `ALLOWED_CLIENT_ORIGINS=*`
  allows all browser origins
- `HOST=127.0.0.1`
  keeps Node private behind Caddy
- `PORT=8080`
  local Node listener

## 10. Install systemd Service

The example service file in this repo uses:

- user: `bladevault`
- group: `bladevault`
- working directory: `/opt/bladevault-backup-server`
- env file: `/opt/bladevault-backup-server/.env`
- command: `/usr/bin/node server.js`

Install it:

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

## 11. Configure Caddy

Example `/etc/caddy/Caddyfile`:

```caddy
backup.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Public check:

```bash
curl -I https://backup.example.com/health
```

## 12. Deploy Updates Later

When the backup server code changes:

1. copy updated files into `/opt/bladevault-backup-server`
2. run `npm ci --omit=dev` if dependencies changed
3. restart the service

Typical update commands:

```bash
cd /opt/bladevault-backup-server
npm ci --omit=dev
sudo systemctl restart bladevault-backup-server
sudo systemctl status bladevault-backup-server --no-pager
```

## 13. Operational Checks

Health:

```bash
curl http://127.0.0.1:8080/health
curl -I https://backup.example.com/health
```

Logs:

```bash
sudo journalctl -u bladevault-backup-server -n 200 --no-pager
sudo journalctl -u caddy -n 200 --no-pager
```

Stored files:

```bash
sudo find /var/lib/bladevault-backups -maxdepth 3 -type f | sort
```

## 14. Acceptance Checklist

- SSH key login works
- password SSH login is disabled
- firewall allows only `22`, `80`, `443`
- `backup.example.com` resolves correctly
- Caddy serves HTTPS successfully
- `/var/lib/bladevault-backups` exists and is writable by `bladevault`
- the backup API binds to `127.0.0.1:8080`
- `curl -I https://backup.example.com/health` returns `200`
- a real backup creates `latest.tar.gz` and `metadata.json`
- restore works from `GET /backup/latest`

## Related Docs

- [docs/architecture.md](architecture.md)
- [docs/migration-to-linux-backup-server.md](migration-to-linux-backup-server.md)
