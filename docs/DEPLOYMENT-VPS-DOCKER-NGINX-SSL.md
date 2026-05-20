# VPS Deployment Runbook (Docker + Nginx + SSL)

This runbook deploys the Shopify voice-agent SaaS on a VPS using Docker Compose, Nginx reverse proxy, and Let's Encrypt SSL.

## 1) Prerequisites

- VPS with Ubuntu 22.04+ (or similar Linux)
- Domain pointing to VPS public IP (A record)
- Ports `80` and `443` open in firewall
- Docker + Docker Compose installed

## 2) Clone and configure

```bash
git clone <your-repo-url> /opt/shopify-agent
cd /opt/shopify-agent
cp .env.example .env
```

Fill `.env` with production values (minimum):

- `NODE_ENV=production`
- `DATABASE_URL=postgresql://...`
- `JWT_SECRET=...`
- `ENCRYPTION_KEY=...`
- `CORS_ORIGIN=https://your-domain.com`
- `PUBLIC_WEBHOOK_BASE_URL=https://your-domain.com`
- `NEXT_PUBLIC_APP_URL=https://your-domain.com`
- `NEXT_PUBLIC_API_URL=http://api:3001` (used by server-side web proxy routes)
- `SHOPIFY_API_KEY=...`
- `SHOPIFY_API_SECRET=...`
- `SHOPIFY_SCOPES=read_products,read_orders,read_customers`

## 3) Set Nginx domain

Edit `infra/nginx/default.conf` and replace:

- `example.com`
- `www.example.com`

with your real domain(s).

## 4) Build and start stack

```bash
docker compose -f infra/docker/docker-compose.prod.yml up -d --build
```

## 5) Issue first SSL certificate

Run one-time cert request:

```bash
docker compose -f infra/docker/docker-compose.prod.yml run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d your-domain.com -d www.your-domain.com \
  --email you@example.com --agree-tos --no-eff-email
```

Then reload Nginx:

```bash
docker compose -f infra/docker/docker-compose.prod.yml restart nginx
```

Optional auto-renew loop:

```bash
docker compose -f infra/docker/docker-compose.prod.yml --profile ssl up -d certbot
```

## 6) Database migration

After first deploy (and after schema changes):

```bash
docker compose -f infra/docker/docker-compose.prod.yml exec api pnpm --filter api exec prisma migrate deploy
```

## 7) Verify

- Open `https://your-domain.com`
- Login and open dashboard
- Go to `Stores` page and connect Shopify
- Confirm webhook endpoint reaches:
  - `https://your-domain.com/api/integrations/shopify/webhooks`
- Confirm Twilio webhook endpoints:
  - `https://your-domain.com/api/twilio/voice/inbound`
  - `https://your-domain.com/api/twilio/voice/gather`
  - `https://your-domain.com/api/twilio/voice/status`

## 8) Operations

Common commands:

```bash
# logs
docker compose -f infra/docker/docker-compose.prod.yml logs -f api
docker compose -f infra/docker/docker-compose.prod.yml logs -f web
docker compose -f infra/docker/docker-compose.prod.yml logs -f nginx

# restart
docker compose -f infra/docker/docker-compose.prod.yml restart api web nginx

# update deployment
git pull
docker compose -f infra/docker/docker-compose.prod.yml up -d --build
docker compose -f infra/docker/docker-compose.prod.yml exec api pnpm --filter api exec prisma migrate deploy
```

