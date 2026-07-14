/**
 * Apply SQL migrations when DATABASE_URL is configured.
 * Usage: npx tsx scripts/runMigrations.ts
 *
 * Only forward migrations are applied. Files ending in `.down.sql` are
 * intentionally excluded — rollbacks are manual operator steps so a botched
 * deploy cannot be silently reverted by rerunning the migration runner.
 */
import "../src/bootstrapEnv.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "migrations");
const FORWARD_MIGRATION_RE = /^\d+_.+\.sql$/;

const files = readdirSync(migrationsDir)
  .filter((name) => FORWARD_MIGRATION_RE.test(name) && !name.endsWith(".down.sql"))
  .sort();

const pg = await import("pg");
const pool = new pg.default.Pool({ connectionString: databaseUrl });

try {
  for (const file of files) {
    const migrationPath = join(migrationsDir, file);
    const sql = readFileSync(migrationPath, "utf8");
    await pool.query(sql);
    console.log("Migration applied:", migrationPath);
  }
} finally {
  await pool.end();
}
