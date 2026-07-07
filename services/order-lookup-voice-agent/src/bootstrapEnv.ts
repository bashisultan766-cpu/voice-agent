/**
 * Load .env from the service root before any other application modules read process.env.
 * PM2 often starts with cwd=/var/www/voice-agent — default dotenv cwd lookup misses this file.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_FILE_PATH = resolve(SERVICE_ROOT, ".env");

loadEnv({ path: ENV_FILE_PATH });
