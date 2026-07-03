/**
 * Apply SQL migrations when DATABASE_URL is configured.
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/runMigrations.ts
 */
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
const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
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
