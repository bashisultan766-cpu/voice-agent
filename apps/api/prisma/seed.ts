import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Intentionally empty: workspaces and users are created through the admin app
 * (`POST /api/auth/register` / `/register`). No demo accounts or sample data.
 *
 * To wipe the database and start clean: `pnpm db:reset` (from repo root), then migrate and register again.
 */
async function main() {
  console.log(
    JSON.stringify({
      ok: true,
      message:
        'No seed data. Create your organization at /register in the dashboard, then sign in with your workspace slug, email, and password.',
    }),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
