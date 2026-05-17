# Deployment guide

## Quick install (recommended)

`install.sh` handles everything: system packages, Node.js, build, system user, and service registration.

```bash
# Default — reads GIT_REPO from environment
GIT_REPO=https://github.com/your-user/evs-app.git bash <(curl -fsSL https://your-host/install.sh)

# Or download and inspect first
curl -fsSL https://your-host/install.sh -o install.sh
less install.sh
bash install.sh
```

### Supported systems

| System | Init system | Node.js source |
|--------|-------------|----------------|
| Alpine Linux 3.19+ | OpenRC | Alpine packages |
| Debian / Ubuntu / Raspbian | systemd | NodeSource |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_REPO` | *(required)* | Git clone URL |
| `APP_DIR` | `/opt/evs-app` | Install directory |
| `APP_USER` | `evs` | System user (created if missing) |
| `APP_PORT` | `3000` | HTTP port |
| `NODE_VERSION` | `22` | Node.js major version (Debian only) |

### What the script does

1. Detects the OS (Alpine vs Debian-based).
2. Installs `git`, `curl`, `ca-certificates`, and Node.js.
3. Creates a system user `evs` (no login shell, no home directory).
4. Clones the repository into `APP_DIR` (or `git pull` if already present).
5. Runs `npm ci && npm run build`.
6. Sets ownership of `APP_DIR` to `evs`.
7. Installs and starts a system service (`evs-app`).

### Updating

Re-run the install script. It detects an existing clone and runs `git pull` + rebuild.

```bash
bash /opt/evs-app/install.sh   # if you kept the script locally
# or re-curl it
```

---

## Manual deployment

If you prefer to control each step:

```bash
# 1. Build locally
npm ci
npm run build

# 2. Copy to server (dist/, dist-server/, package.json, node_modules/)
rsync -av --exclude='node_modules' . user@server:/opt/evs-app/
ssh user@server "cd /opt/evs-app && npm ci --omit=dev"

# 3. Start
PORT=3000 NODE_ENV=production node /opt/evs-app/dist-server/server.js
```

---

## Service management

### Debian / Ubuntu (systemd)

```bash
systemctl status evs-app      # check status
systemctl restart evs-app     # restart
journalctl -u evs-app -f      # live logs
systemctl stop evs-app        # stop
systemctl disable evs-app     # remove from autostart
```

### Alpine (OpenRC)

```bash
rc-service evs-app status     # check status
rc-service evs-app restart    # restart
tail -f /var/log/evs-app.log  # live logs
rc-service evs-app stop       # stop
rc-update del evs-app default # remove from autostart
```

---

## Reverse proxy (optional)

To expose the app on port 80/443, put Nginx or Caddy in front:

### Nginx

```nginx
server {
    listen 80;
    server_name evs.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Caddy

```
evs.example.com {
    reverse_proxy localhost:3000
}
```

Caddy handles TLS automatically via Let's Encrypt.

---

## Container (Docker)

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist-server/server.js"]
```

```bash
docker build -t evs-app .
docker run -d -p 3000:3000 --name evs-app evs-app
```

---

## Notes

- **No database required** — all user data lives in the browser (localStorage + IndexedDB). The server holds no state.
- **Single user** — the app is designed for personal use; there is no authentication layer on the server itself.
- **Port conflicts** — if port 3000 is taken, set `APP_PORT=8080` (or any free port) before running the install script.
