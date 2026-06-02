import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Fallback URL so `prisma generate` succeeds in CI/dev without a populated .env.
    url:
      process.env.DATABASE_URL?.trim() ||
      'postgresql://postgres:postgres@localhost:5432/bookstore_voice',
  },
});
