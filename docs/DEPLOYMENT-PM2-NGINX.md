# PM2 / systemd + Nginx (ports 3000 / 3001)

Use this when the **Next.js** app and **Nest API** run on the host (not Docker), behind Nginx on `agent.mailcallcommunication.com`.

## Port map (matches repo defaults)

| Service | Port | Env |
|---------|------|-----|
| Next.js (`apps/web`) | **3000** | `PORT=3000` in `apps/web` (see `package.json` / `server.ts`) |
| Nest API (`apps/api`) | **3001** | `PORT=3001` in `apps/api/.env` |

Verify on the VPS:

```bash
ss -tlnp | grep -E ':3000|:3001'
curl -sS http://127.0.0.1:3001/api/health
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
```

## Nginx config

Copy the site file from the repo:

```bash
sudo cp /opt/shopify-agent/infra/nginx/voice-agent.mailcallcommunication.com.conf \
  /etc/nginx/sites-available/voice-agent.conf
sudo ln -sf /etc/nginx/sites-available/voice-agent.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**Default in `infra/nginx/voice-agent.mailcallcommunication.com.conf`:** split upstreams:

- `location ~ ^/api/auth/(login|register|logout|session-sync)$` → **Next** (`3000`) so httpOnly `va_access_token` is set
- `location /api/` → **Nest** (`3001`) (**no trailing slash** on `proxy_pass`, so `/api/agents` stays `/api/agents`)
- `location /` → **Next** (`3000`)
- `GET /session/bootstrap` → **Next** (restores localStorage JWT from the cookie when `/api` hits Nest directly)

Do **not** use `proxy_pass http://127.0.0.1:3001/;` — the trailing slash strips `/api/` and Nest returns 404.

The dashboard sends `Authorization: Bearer` from the browser (localStorage after login), so `/api/*` can hit Nest directly. Set `TRUST_PROXY=true` on the API for Twilio `X-Forwarded-*` headers.

## Production `.env` (minimum)

Root or `apps/api/.env` + `apps/web/.env.local`:

```bash
NODE_ENV=production
PORT=3001
TRUST_PROXY=true
CORS_ORIGIN=https://agent.mailcallcommunication.com
PUBLIC_WEBHOOK_BASE_URL=https://agent.mailcallcommunication.com

# Full-duplex realtime voice (Twilio Media Streams — NOT a wss:// voice webhook URL)
VOICE_MEDIA_STREAM_ENABLED=true
OPENAI_REALTIME_ENABLED=true
REALTIME_MULTI_AGENT_ENABLED=true
ELEVENLABS_STREAMING_TTS_ENABLED=true
GATHER_FALLBACK_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379

NEXT_PUBLIC_APP_URL=https://agent.mailcallcommunication.com
NEXT_PUBLIC_API_URL=http://127.0.0.1:3001
# Server-side Next → API (same host)
INTERNAL_API_URL=http://127.0.0.1:3001
```

After deploy, confirm startup log `realtime_pipeline_enabled` with `"fullDuplex":true` and `GET /api/realtime-voice/health` shows `fullDuplexEnabled:true`. Twilio **voice webhook** stays HTTPS `.../api/twilio/voice/inbound`; that endpoint returns TwiML `<Connect><Stream url="wss://.../api/realtime-voice/media-stream">`.

Twilio webhooks in the console must use:

- `https://agent.mailcallcommunication.com/api/twilio/voice/inbound`
- `https://agent.mailcallcommunication.com/api/twilio/voice/gather`
- `https://agent.mailcallcommunication.com/api/twilio/voice/status`

With the **split** config, those URLs go straight to Nest; Nginx must send `X-Forwarded-Proto` and `X-Forwarded-Host` (included in the site file).

## Start processes (example)

From repo root (after `pnpm --filter api build` and `pnpm --filter web build`):

```bash
pm2 start infra/ecosystem.config.cjs
pm2 logs voice-agent-api --lines 50
pm2 logs voice-agent-web --lines 50
```

**Do not** start the API with `tsx` or `nest start` under PM2. If logs show `.ts` paths and `Cannot read properties of undefined (reading 'get')`, fix PM2 to use `node dist/main.js` only.

Manual start (equivalent):

```bash
cd /var/www/voice-agent/apps/api && PORT=3001 NODE_ENV=production node dist/main.js
cd /opt/shopify-agent/apps/web && PORT=3000 HOSTNAME=127.0.0.1 NODE_ENV=production pnpm start
```

The repo ships PM2 config at `ecosystem.config.cjs` (recommended on VPS):

```bash
cd /opt/shopify-agent
pm2 start ecosystem.config.cjs --update-env
pm2 save
```

## Smoke test through Nginx

```bash
curl -sS https://agent.mailcallcommunication.com/api/health
curl -sS -o /dev/null -w "%{http_code}\n" https://agent.mailcallcommunication.com/
```

Login in the browser and open **Dashboard → Agents** to confirm `/api/agents` works end-to-end.
