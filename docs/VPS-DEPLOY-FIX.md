# VPS deploy fix and PM2 troubleshooting

## What you saw

| Symptom | Meaning |
|---------|---------|
| `voice-web` **errored**, ↺ 60 | Process crashed on start many times (missing build, env, or port conflict). |
| After `pm2 restart`, both **online** | Restart can work if the underlying issue was transient; check logs anyway. |
| `http://YOUR_VPS_IP:3000: No such file or directory` | **Not a URL command.** Bash tried to run a file named `http://...`. Use a browser or `curl`. |
| `client_loop: send disconnect` | SSH session dropped (network/idle). Reconnect with `ssh root@srv1609894` (or your host). |

## Access the app (replace the placeholder)

On your **PC browser** (not in the SSH shell):

```text
http://YOUR_SERVER_PUBLIC_IP:3000
```

Example if your VPS IP is `203.0.113.10`:

```text
http://203.0.113.10:3000
```

From **on the VPS** (sanity check):

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
curl -sS http://127.0.0.1:3001/api/health
```

If `curl` works on the server but the browser cannot connect, open firewall port **3000** (and **3001** if needed):

```bash
sudo ufw allow 3000/tcp
sudo ufw allow 3001/tcp
sudo ufw status
```

Production should usually use **Nginx + HTTPS** on 443 instead of exposing 3000 publicly — see [DEPLOYMENT-VPS-DOCKER-NGINX-SSL.md](./DEPLOYMENT-VPS-DOCKER-NGINX-SSL.md).

---

## 1) Push from your PC (when repo fixes change)

```powershell
cd "e:\Agents\shopify agent"
git add -A
git commit -m "fix(deploy): PM2 ecosystem and VPS runbook"
git push origin main
```

## 2) Deploy on VPS

```bash
cd /var/www/voice-agent
git pull origin main

export VOICE_AGENT_DATABASE_URL="postgresql://USER:PASS@localhost:5432/voice_agent"

chmod +x scripts/vps-deploy.sh
./scripts/vps-deploy.sh
# or: pnpm deploy:vps
```

Ensure env files exist **before** PM2 start:

```bash
test -f apps/api/.env && echo "api .env OK" || echo "MISSING apps/api/.env"
test -f apps/web/.env.local && echo "web .env.local OK" || echo "MISSING apps/web/.env.local"
test -d apps/web/.next && echo "web build OK" || echo "RUN pnpm build (web missing .next)"
test -f apps/api/dist/main.js && echo "api build OK" || echo "RUN pnpm build (api missing dist)"
```

## 3) PM2 (use repo root ecosystem)

From `/var/www/voice-agent`:

```bash
pm2 delete voice-api voice-web voice-agent-api voice-agent-web 2>/dev/null || true
pm2 start ecosystem.config.cjs --update-env
pm2 save
pm2 status
```

Restart after editing `.env` / `.env.local`:

```bash
pm2 restart voice-api voice-web --update-env
```

## 4) If `voice-web` is errored again

```bash
pm2 logs voice-web --lines 80
```

| Log message | Fix |
|-------------|-----|
| `port 3000 is already in use` | `sudo ss -tlnp \| grep :3000` — stop duplicate process or change `PORT` in PM2 env. |
| `server failed to start` / Prisma | Set `VOICE_AGENT_DATABASE_URL` in `apps/web/.env.local`; run `pnpm db:voice:migrate:deploy`. |
| `Cannot find module` / `tsx` | `cd /var/www/voice-agent && pnpm install`; `cd apps/web && pnpm build`. |
| Missing `.next` | `pnpm build` from repo root (needs successful `next build`). |

API logs:

```bash
pm2 logs voice-api --lines 80
```

## 5) Verify voice-db client

```bash
ls packages/voice-db/generated/client/index.js
pnpm db:voice:generate
grep CallSession packages/voice-db/prisma/schema.prisma && echo BAD || echo OK
```

## 6) Required web env (minimum)

In `apps/web/.env.local`:

- `NEXT_PUBLIC_APP_URL` — public URL users open (e.g. `http://YOUR_IP:3000` or `https://your-domain.com`)
- `NEXT_PUBLIC_API_URL` — browser/API base (e.g. `http://YOUR_IP:3001` or proxied `/api`)
- `INTERNAL_API_URL=http://127.0.0.1:3001` (recommended on VPS so server-side proxy hits local API)
- `VOICE_AGENT_DATABASE_URL` — Postgres for voice tables
- `VOICE_PUBLIC_BASE_URL` — same origin as the web app (HTTPS in production)
