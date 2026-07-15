import "./bootstrapEnv.js";

import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { getConfig, MAILCALL_API_PREFIX } from "./config.js";
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

  server.listen(cfg.MAILCALL_PORT, () => {
    logger.info("mailcall_server_listening", {
      port: cfg.MAILCALL_PORT,
      inbound: `${MAILCALL_API_PREFIX}/inbound`,
      ws: `${MAILCALL_API_PREFIX}/ws`,
    });
  });

  return server;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") || process.argv[1].endsWith("index.js"));

if (isMain) {
  try {
    startServer();
  } catch (err) {
    logger.error("mailcall_boot_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
