# Step 2 — Complete checklist

Step 2 complete تب مانیں جب یہ سب ہو جائیں:

- [ ] **Repo run ہو رہا ہو** — `pnpm dev` سے دونوں apps start ہوں
- [ ] **Frontend کھل رہا ہو** — http://localhost:3000 اور Dashboard sidebar/pages نظر آئیں
- [ ] **Backend کھل رہا ہو** — http://localhost:3001
- [ ] **Health endpoint کام کر رہا ہو** — http://localhost:3001/api/health → `{ status: "ok", database: "connected" }` (after DB up + migrate)
- [ ] **Database migrate ہو چکی ہو** — `pnpm db:migrate` run ہو، tables بن گئی ہوں
- [ ] **Prisma client generate ہو گیا ہو** — `pnpm db:generate` یا `pnpm build` کے بعد کوئی Prisma import error نہ ہو
- [ ] **Basic dashboard skeleton visible ہو** — /dashboard, /dashboard/stores, /dashboard/agents, etc.
- [ ] **Stores/Agents modules scaffold ہو گئے ہوں** — API پر POST/GET stores اور POST/GET/PATCH/DELETE agents (بدون auth)

## Commands to verify

```bash
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d
# Copy .env from docs/ENV-EXAMPLE-Step2.md
pnpm db:generate
pnpm db:migrate
pnpm dev
# Open http://localhost:3000 and http://localhost:3001/api/health
```

## Important note

ابھی Twilio, Shopify, OpenAI کی live integration شروع نہیں کرنی — وہ Step 3 اور Step 4 میں آئے گی۔
