/**
 * PM2 — both voice agents (concurrent, isolated).
 *
 * SureShot Bookstore (order lookup):
 *   POST /conversationBrain/inbound  → :8001
 *   WS   /conversationBrain/ws        → :8001
 *
 * Mail Call Communication Newspaper:
 *   POST /api/voice/mailcall/inbound  → :8010
 *   WS   /api/voice/mailcall/ws       → :8010
 *
 * Env: merges repo-root `.env` + `services/mailcall-voice-agent/.env`
 * (MAILCALL_* only). Exit code 78 = bad config → do not restart-loop.
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const orderLookupDir = path.join(root, "services", "order-lookup-voice-agent");
const mailcallDir = path.join(root, "services", "mailcall-voice-agent");
const mailcallDistEntry = path.join(mailcallDir, "dist", "index.js");
const rootEnvPath = path.join(root, ".env");
const mailcallEnvPath = path.join(mailcallDir, ".env");
const mailcallLogDir = "/logs/mailcall";

function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function pickMailCallEnv(all) {
  const picked = {
    NODE_ENV: "production",
    MAILCALL_PORT: all.MAILCALL_PORT || "8010",
  };
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("MAILCALL_")) picked[key] = value;
  }
  // Prefer an explicit file if present so runtime dotenv can re-read it.
  if (fs.existsSync(rootEnvPath)) {
    picked.MAILCALL_ENV_FILE = rootEnvPath;
  } else if (fs.existsSync(mailcallEnvPath)) {
    picked.MAILCALL_ENV_FILE = mailcallEnvPath;
  }
  return picked;
}

const mergedEnv = {
  ...loadEnvFile(mailcallEnvPath),
  ...loadEnvFile(rootEnvPath),
};

if (!fs.existsSync(mailcallDistEntry)) {
  console.warn(
    `[ecosystem] WARN: missing ${mailcallDistEntry} — run: cd services/mailcall-voice-agent && npm ci && npm run build`,
  );
}

if (!fs.existsSync(rootEnvPath) && !fs.existsSync(mailcallEnvPath)) {
  console.warn(
    `[ecosystem] WARN: no .env at ${rootEnvPath} or ${mailcallEnvPath}. ` +
      "mailcall-voice-agent will exit with code 78 until MAILCALL_* is configured.",
  );
}

module.exports = {
  apps: [
    {
      name: "order-lookup-voice-agent",
      cwd: orderLookupDir,
      script: "dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "mailcall-voice-agent",
      cwd: mailcallDir,
      // Compiled entry (tsc → dist/). Do NOT point at src/*.ts.
      script: "dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // 78 = CONFIG_EXIT_CODE — missing/invalid MAILCALL_* (stop restart storm)
      stop_exit_codes: [78],
      max_restarts: 15,
      min_uptime: "10s",
      exp_backoff_restart_delay: 200,
      max_memory_restart: "300M",
      out_file: path.join(mailcallLogDir, "combined.log"),
      error_file: path.join(mailcallLogDir, "error.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      env: pickMailCallEnv(mergedEnv),
    },
  ],
};
