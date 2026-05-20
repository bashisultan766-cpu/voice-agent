# Local setup — fix "Backend API is not reachable"

The **Test connection** button in the dashboard calls the backend API at `http://localhost:3001`. If the API is not running, you see:

> Backend API is not reachable at http://localhost:3001. Start the API (e.g. from repo root: pnpm dev, or run the api app on port 3001).

## Fix: start the API

### Option 1 — Run everything (recommended)

From the **repo root** (folder with `package.json` and `apps/`):

```bash
pnpm install
pnpm dev
```

This starts both the **web app** (port 3000) and the **API** (port 3001). Test connection will work.

### Option 2 — API only (e.g. web already running)

In a **second terminal**, from repo root:

```bash
pnpm dev:api
```

Keep this terminal open. Use the web app in the other terminal or browser.

---

## If the API fails to start

The API needs **PostgreSQL** and **DATABASE_URL**.

### 1. Start PostgreSQL (Docker)

From repo root:

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

### 2. Environment

Create or edit `.env` in the **repo root** (or in `apps/api/` if the API reads it from there):

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bookstore_agents
PORT=3001
```

If you don’t have a `.env` yet:

```bash
cp .env.example .env
# Edit .env and set DATABASE_URL as above.
```

### 3. Database migrations

From repo root:

```bash
pnpm db:generate
pnpm db:migrate
```

### 4. Start again

```bash
pnpm dev
```

---

## If it still doesn’t work

Share:

1. The **exact error** when you run `pnpm dev` or `pnpm dev:api` (copy from the terminal).
2. Whether **PostgreSQL** is running (e.g. Docker container up, or local Postgres on port 5432).
3. Whether you have a **`.env`** file with `DATABASE_URL` set.

Then we can pinpoint the next step.
