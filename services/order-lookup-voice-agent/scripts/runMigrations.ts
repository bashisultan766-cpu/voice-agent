/**
 * Apply SQL migrations when DATABASE_URL is configured.
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/runMigrations.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = join(root, "migrations", "001_call_events.sql");
const sql = readFileSync(migrationPath, "utf8");

const pg = await import("pg");
const pool = new pg.default.Pool({ connectionString: databaseUrl });

try {
  await pool.query(sql);
  console.log("Migration applied:", migrationPath);
} finally {
  await pool.end();
}
