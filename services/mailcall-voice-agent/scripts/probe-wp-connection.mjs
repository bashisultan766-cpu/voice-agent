/**
 * Standalone WordPress REST connectivity probe for Mail Call.
 * Targets MAILCALL_WP_URL (default https://mailcallnewspaper.com) with the
 * same 2000ms budget used by the production client.
 *
 * Usage (from service root):
 *   npm run probe:wp
 *
 * Credentials are read from env / .env — never printed.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(here, "..");
const repoRoot = resolve(serviceRoot, "../..");
const DEFAULT_WP = "https://mailcallnewspaper.com";
const TIMEOUT_MS = 2000;

for (const path of [resolve(repoRoot, ".env"), resolve(serviceRoot, ".env")]) {
  if (existsSync(path)) loadDotenv({ path, override: false });
}

function cleanPassword(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function sanitizeBase(raw) {
  let s = String(raw ?? "")
    .trim()
    .replace(/[\r\n\t]+/g, "");
  if (!s) s = DEFAULT_WP;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

const base = sanitizeBase(process.env.MAILCALL_WP_URL);
const user = String(process.env.MAILCALL_WP_USER ?? "").trim();
const password = cleanPassword(process.env.MAILCALL_WP_APP_PASSWORD);
const url = `${base}/wp-json/wp/v2/posts?per_page=1`;
const timeoutMs = Number(process.env.MAILCALL_WP_TIMEOUT_MS) > 0
  ? Number(process.env.MAILCALL_WP_TIMEOUT_MS)
  : TIMEOUT_MS;

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};
if (user && password) {
  headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

const started = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

console.log(
  JSON.stringify({
    event: "wp_probe_start",
    url,
    timeoutMs,
    authConfigured: Boolean(user && password),
    userSet: Boolean(user),
    passwordLength: password.length,
  }),
);

try {
  const res = await fetch(url, { headers, signal: controller.signal });
  clearTimeout(timer);
  const elapsedMs = Date.now() - started;
  let count = null;
  try {
    const body = await res.json();
    count = Array.isArray(body) ? body.length : null;
  } catch {
    count = null;
  }

  console.log(
    JSON.stringify({
      event: "wp_probe_result",
      ok: res.ok,
      status: res.status,
      elapsedMs,
      withinBudget: elapsedMs <= timeoutMs,
      postsReturned: count,
      fallbackWouldApply: !res.ok,
    }),
  );
  process.exit(res.ok ? 0 : 2);
} catch (err) {
  clearTimeout(timer);
  const elapsedMs = Date.now() - started;
  const name = err?.name || "Error";
  const message = String(err?.message || err);
  const timedOut = name === "AbortError" || /aborted|ETIMEDOUT|timeout/i.test(message);

  console.log(
    JSON.stringify({
      event: "wp_probe_result",
      ok: false,
      status: null,
      elapsedMs,
      withinBudget: false,
      timedOut,
      reason: timedOut ? "ETIMEDOUT" : message.slice(0, 120),
      fallbackWouldApply: true,
      note: "[WP_CLIENT_OFFLINE] Routing query to static local brand profile.",
    }),
  );
  process.exit(timedOut ? 3 : 2);
}
