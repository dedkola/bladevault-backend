# Ubuntu 24 Backup Server Setup

This guide prepares the Linux server that will store per-user BladeVault backup archives.

## Goal

Host a backup API on a configurable public domain such as:

- `https://backup.bladevault.app`

Expected API shape:

- `GET /health`
- `GET /backup/meta`
- `PUT /backup/latest`
- `GET /backup/latest`
- optional `GET /backup/history`

## Prerequisites

- Ubuntu 24 server
- SSH access
- DNS control for `backup.bladevault.app`
- one fixed auth domain already configured in the Worker, e.g. `https://auth.bladevault.app`

## 1. Create deploy user

```bash
adduser bladevault
usermod -aG sudo bladevault
```

Install your SSH public key:

```bash
mkdir -p /home/bladevault/.ssh
chmod 700 /home/bladevault/.ssh
nano /home/bladevault/.ssh/authorized_keys
chmod 600 /home/bladevault/.ssh/authorized_keys
chown -R bladevault:bladevault /home/bladevault/.ssh
```

## 2. Harden SSH

Edit:

```bash
sudo nano /etc/ssh/sshd_config
```

Recommended minimum changes:

- `PasswordAuthentication no`
- `PermitRootLogin no`

Restart SSH:

```bash
sudo systemctl restart ssh
```

## 3. Enable firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## 4. Install runtime packages

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

## 5. Create app and storage directories

```bash
sudo mkdir -p /opt/bladevault-backup-server
sudo mkdir -p /var/lib/bladevault-backups
sudo chown -R bladevault:bladevault /opt/bladevault-backup-server
sudo chown -R bladevault:bladevault /var/lib/bladevault-backups
chmod 750 /var/lib/bladevault-backups
```

Expected storage layout:

```text
/var/lib/bladevault-backups/
  <userId>/
    latest.tar.gz
    metadata.json
    history/
```

## 6. DNS

Point:

- `backup.bladevault.app`

to the Ubuntu server public IP.

## 7. Environment the backup server will need

Create an env file later for the backup API with at least:

```env
BACKUP_PUBLIC_BASE_URL=https://backup.bladevault.app
BACKUP_STORAGE_ROOT=/var/lib/bladevault-backups
AUTH_JWT_ISSUER=https://auth.bladevault.app
AUTH_JWT_AUDIENCE=https://auth.bladevault.app
AUTH_JWKS_URL=https://auth.bladevault.app/api/auth/jwks
MAX_BACKUP_SIZE_MB=50
ALLOWED_CLIENT_ORIGINS=http://localhost:*,http://127.0.0.1:*,http://[::1]:*
HOST=127.0.0.1
PORT=8080
```

`ALLOWED_CLIENT_ORIGINS` is needed because the browser frontend calls the backup
domain directly and sends `Authorization` headers. Keep this list tight, but it
can use wildcard ports for local development.

## 8. Reverse proxy target

The Node backup API should listen only on localhost, for example:

- `127.0.0.1:8080`

Caddy terminates TLS and proxies to that port.

Example Caddyfile:

```caddy
backup.bladevault.app {
  reverse_proxy 127.0.0.1:8080
}
```

Then:

```bash
sudo systemctl reload caddy
```

## 9. Systemd service target

The backup API should later run as a service, for example:

- working directory: `/opt/bladevault-backup-server`
- user: `bladevault`
- group: `bladevault`
- command: `node server.js`

The implementation in this repo lives in:

- [backup-server/server.js](/Users/kolasokol/Code/bladevault-backend/backup-server/server.js)
- [backup-server/package.json](/Users/kolasokol/Code/bladevault-backend/backup-server/package.json)
- [backup-server/.env.example](/Users/kolasokol/Code/bladevault-backend/backup-server/.env.example)

Suggested deploy steps:

```bash
cd /opt/bladevault-backup-server
npm ci --omit=dev
node server.js
```

## 10. Acceptance checklist

- SSH key login works
- password SSH login is disabled
- firewall allows only `22`, `80`, `443`
- `backup.bladevault.app` resolves correctly
- Caddy serves HTTPS successfully
- `/var/lib/bladevault-backups` exists and is writable by the app user
- the backup API binds to `127.0.0.1:8080`
- `curl -I https://backup.bladevault.app/health` returns `200`
