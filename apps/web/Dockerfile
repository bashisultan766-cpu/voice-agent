FROM node:20-alpine

WORKDIR /app

RUN corepack enable

# Copy workspace manifests first for better Docker layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/voice-db/package.json packages/voice-db/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# Prisma generate only needs a valid URL shape (not a live DB).
ENV VOICE_AGENT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/voice_agent
RUN pnpm --filter @bookstore-voice-agents/voice-db run generate
RUN pnpm --filter web build

EXPOSE 3000

CMD ["pnpm", "--filter", "web", "start"]

