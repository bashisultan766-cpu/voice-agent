import "./bootstrapEnv.js";

import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import {
  CONFIG_EXIT_CODE,
  DEFAULT_MAILCALL_PORT,
  getConfig,
  MAILCALL_API_PREFIX,
  resolveListenPort,
  validateConfig,
} from "./config.js";
import { envLoadReport } from "./bootstrapEnv.js";
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
      port: resolveListenPort(),
    });
  });

  // Isolated namespace — never overlaps /conversationBrain or other agent routes.
  app.use(MAILCALL_API_PREFIX, createMailCallRouter());

  return app;
}

/**
 * Bind HTTP immediately. No WordPress / OpenAI / cache I/O before listen —
 * those run only on inbound call turns.
 */
export function startServer() {
  console.log("LOG: Attempting to connect/initialize modules...");

  const cfg = getConfig();
  setLogLevel(cfg.MAILCALL_LOG_LEVEL);

  const port = cfg.MAILCALL_PORT || DEFAULT_MAILCALL_PORT;
  const bindHost = process.env.MAILCALL_BIND_HOST?.trim() || "0.0.0.0";

  const app = createApp();
  const server = http.createServer(app);

  // Attach WS to the same HTTP server (does not delay listen).
  const wss = new WebSocketServer({ server, path: `${MAILCALL_API_PREFIX}/ws` });
  attachMailCallRelayHandler(wss);

  console.log(`LOG: Explicitly invoking server.listen() on port ${port} (host ${bindHost})...`);

  server.listen(port, bindHost, () => {
    const addr = server.address();
    console.log(
      `LOG: server.listen() SUCCESS — bound ${typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : port}`,
    );
    logger.info("mailcall_server_listening", {
      port,
      bind: bindHost,
      inbound: `${MAILCALL_API_PREFIX}/inbound`,
      ws: `${MAILCALL_API_PREFIX}/ws`,
      envFilesLoaded: envLoadReport.loaded,
    });
  });

  server.on("error", (err) => {
    console.error(`LOG: server.listen() FAILED on port ${port}:`, err);
    logger.error("mailcall_server_listen_failed", {
      error: err instanceof Error ? err.message : String(err),
      port,
      bind: bindHost,
    });
    process.exit(1);
  });

  return server;
}

function boot(): void {
  console.log("LOG: Environment variables loaded successfully.");
  console.log(
    `LOG: env files loaded=${envLoadReport.loaded.length ? envLoadReport.loaded.join(" | ") : "(none)"}`,
  );
  console.log(
    `LOG: resolved listen port=${resolveListenPort()} (MAILCALL_PORT=${process.env.MAILCALL_PORT ?? ""} PORT=${process.env.PORT ?? ""})`,
  );
  console.log(`LOG: argv1=${process.argv[1] ?? "(none)"} cwd=${process.cwd()}`);

  const validation = validateConfig();
  if (!validation.ok) {
    console.error(validation.message);
    logger.error("mailcall_boot_config_invalid", {
      exitCode: CONFIG_EXIT_CODE,
      envFilesLoaded: envLoadReport.loaded,
      envCandidates: envLoadReport.candidates,
    });
    process.exit(CONFIG_EXIT_CODE);
  }

  try {
    // Synchronous path to listen() — no awaits / external API calls.
    startServer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("LOG: boot exception before listen:", message);
    logger.error("mailcall_boot_failed", { error: message });
    process.exit(1);
  }
}

/**
 * Always boot as the PM2/node entrypoint.
 *
 * Do NOT gate on process.argv[1] ending in index.js — under PM2 fork mode
 * argv[1] is often ProcessContainerFork.js, which previously skipped listen()
 * while leaving the process "online" with memory allocated and no port bind.
 */
const runningUnderVitest = Boolean(process.env.VITEST);
if (!runningUnderVitest) {
  boot();
}
