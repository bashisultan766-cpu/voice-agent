import "./bootstrapEnv.js";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import {
  CONFIG_EXIT_CODE,
  getConfig,
  MAILCALL_API_PREFIX,
  validateConfig,
} from "./config.js";
import { envLoadReport, SERVICE_ROOT } from "./bootstrapEnv.js";
import { logger, setLogLevel } from "./utils/logger.js";
import {
  attachMailCallRelayHandler,
  createMailCallRouter,
} from "./agents/mailcall/router.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "mailcall-voice-agent",
      agentPrefix: MAILCALL_API_PREFIX,
    });
  });

  // Isolated namespace — never overlaps /conversationBrain or other agent routes.
  app.use(MAILCALL_API_PREFIX, createMailCallRouter());

  return app;
}

export function startServer() {
  const cfg = getConfig();
  setLogLevel(cfg.MAILCALL_LOG_LEVEL);

  const app = createApp();
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: `${MAILCALL_API_PREFIX}/ws` });
  attachMailCallRelayHandler(wss);

  server.listen(cfg.MAILCALL_PORT, "127.0.0.1", () => {
    logger.info("mailcall_server_listening", {
      port: cfg.MAILCALL_PORT,
      bind: "127.0.0.1",
      inbound: `${MAILCALL_API_PREFIX}/inbound`,
      ws: `${MAILCALL_API_PREFIX}/ws`,
      envFilesLoaded: envLoadReport.loaded,
    });
  });

  server.on("error", (err) => {
    logger.error("mailcall_server_listen_failed", {
      error: err instanceof Error ? err.message : String(err),
      port: cfg.MAILCALL_PORT,
    });
    process.exit(1);
  });

  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, "/");
  return normalized.endsWith("/index.js") || normalized.endsWith("/index.ts");
}

function boot(): void {
  const distEntry = resolve(SERVICE_ROOT, "dist/index.js");
  if (!existsSync(distEntry) && isMainModule() && process.argv[1]?.endsWith("index.js")) {
    // Running via node but somehow not from dist — still attempt boot.
  }

  const validation = validateConfig();
  if (!validation.ok) {
    // Use stderr so PM2 error.log always captures the operator message.
    console.error(validation.message);
    logger.error("mailcall_boot_config_invalid", {
      exitCode: CONFIG_EXIT_CODE,
      envFilesLoaded: envLoadReport.loaded,
      envCandidates: envLoadReport.candidates,
    });
    process.exit(CONFIG_EXIT_CODE);
  }

  try {
    startServer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    logger.error("mailcall_boot_failed", { error: message });
    process.exit(1);
  }
}

if (isMainModule()) {
  boot();
}
