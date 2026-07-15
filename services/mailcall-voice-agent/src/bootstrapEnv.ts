/**
 * Load env before config reads process.env.
 *
 * Path resolution works for:
 * - `tsx src/index.ts` (here = src/)
 * - `node dist/index.js` under PM2 (here = dist/)
 * - cwd at repo root or service directory
 *
 * Prefer MAILCALL_ENV_FILE if set, then repo-root `.env`, then service `.env`.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Service root whether this file lives in `src/` or `dist/`. */
export const SERVICE_ROOT = resolve(here, "..");
/** Monorepo / VPS checkout root (`…/voice-agent`). */
export const REPO_ROOT = resolve(SERVICE_ROOT, "../..");

export type EnvLoadReport = {
  candidates: string[];
  loaded: string[];
  missing: string[];
};

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((p) => resolve(p)))];
}

export function resolveEnvCandidates(): string[] {
  const fromEnv = process.env.MAILCALL_ENV_FILE?.trim();
  return uniquePaths([
    ...(fromEnv ? [fromEnv] : []),
    resolve(REPO_ROOT, ".env"),
    resolve(SERVICE_ROOT, ".env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "services/mailcall-voice-agent/.env"),
  ]);
}

export function loadMailCallEnv(): EnvLoadReport {
  const candidates = resolveEnvCandidates();
  const loaded: string[] = [];
  const missing: string[] = [];

  for (const path of candidates) {
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    // Do not override vars already injected by PM2 / the shell.
    loadDotenv({ path, override: false });
    loaded.push(path);
  }

  return { candidates, loaded, missing };
}

export const envLoadReport = loadMailCallEnv();
