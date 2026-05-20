FROM node:20-alpine

WORKDIR /app

RUN corepack enable

# Copy workspace manifests first for better Docker layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/config/package.json packages/config/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build

EXPOSE 3001

CMD ["pnpm", "--filter", "api", "start"]

