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
 * Env: loads MAILCALL_* from the repo-root VPS `.env` into the Mail Call process only.
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const orderLookupDir = path.join(root, "services", "order-lookup-voice-agent");
const mailcallDir = path.join(root, "services", "mailcall-voice-agent");
const rootEnvPath = path.join(root, ".env");
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
  const picked = { NODE_ENV: "production", MAILCALL_PORT: "8010" };
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("MAILCALL_")) picked[key] = value;
  }
  return picked;
}

const rootEnv = loadEnvFile(rootEnvPath);

module.exports = {
  apps: [
    {
      name: "order-lookup-voice-agent",
      cwd: orderLookupDir,
      script: "node",
      args: "dist/index.js",
      interpreter: "none",
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
      script: "node",
      args: "dist/index.js",
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 15,
      min_uptime: "10s",
      exp_backoff_restart_delay: 100,
      max_memory_restart: "300M",
      out_file: path.join(mailcallLogDir, "combined.log"),
      error_file: path.join(mailcallLogDir, "error.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      env: pickMailCallEnv(rootEnv),
    },
  ],
};
