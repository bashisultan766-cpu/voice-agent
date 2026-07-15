/**
 * Load env before config reads process.env.
 * Prefer the VPS repo-root `.env` (MAILCALL_* isolation), then service-local `.env`.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(here, "..");
const repoRoot = resolve(serviceRoot, "../..");

const candidates = [
  resolve(repoRoot, ".env"),
  resolve(serviceRoot, ".env"),
  resolve(process.cwd(), ".env"),
];

for (const path of candidates) {
  if (existsSync(path)) {
    loadDotenv({ path, override: false });
  }
}
