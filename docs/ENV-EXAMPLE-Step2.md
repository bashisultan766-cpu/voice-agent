# Step 2 — .env.example contents

Copy this into a file named `.env` at the repo root. Never commit `.env`.

```env
# Core
NODE_ENV=development
APP_URL=http://localhost:3000
API_URL=http://localhost:3001
NEXT_PUBLIC_API_URL=http://localhost:3001/api

# Database (matches infra/docker/docker-compose.yml)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bookstore_agents?schema=public

# Redis
REDIS_URL=redis://localhost:6379

# Auth (Clerk — Step 3)
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=

# OpenAI
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_API_KEY=
TWILIO_API_SECRET=
TWILIO_TWIML_APP_SID=

# Shopify (app-level; store tokens in DB)
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_WEBHOOK_SECRET=

# Encryption (DB-stored secrets)
ENCRYPTION_KEY=
```

Optional (uncomment when needed): `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SENTRY_DSN`, `POSTHOG_API_KEY`.
