import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Prisma 7 datasource URL; fallback so `prisma generate` works without a local .env file.
    url:
      process.env.VOICE_AGENT_DATABASE_URL?.trim() ||
      'postgresql://postgres:postgres@localhost:5432/voice_agent',
  },
});
