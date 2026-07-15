import "./bootstrapEnv.js";

import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import {
  DEFAULT_MAILCALL_PORT,
  getDegradeReasons,
  initRuntimeConfig,
  isConfigDegraded,
  MAILCALL_API_PREFIX,
  resolveListenPort,
} from "./config.js";
import { envLoadReport } from "./bootstrapEnv.js";
import { logger, setLogLevel } from "./utils/logger.js";
import {
  attachMailCallRelayHandler,
  createMailCallRouter,
} from "./agents/mailcall/router.js";
import { startWordPressMemCache } from "./agents/mailcall/wordpress_api.js";

function healthPayload() {
  const degraded = isConfigDegraded();
  return {
    ok: !degraded,
    degraded,
    service: "mailcall-voice-agent",
    agentPrefix: MAILCALL_API_PREFIX,
    port: resolveListenPort(),
    reasons: degraded ? getDegradeReasons() : [],
  };
}

export function createApp() {
  const app = express();

  // Required behind Nginx TLS termination so req.protocol / Host reflect HTTPS.
  app.set("trust proxy", true);

  /**
   * Preserve exact request bytes for Twilio X-Twilio-Signature checks.
   * Body-parsers otherwise mutate the payload before validation.
   */
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    req.rawBody = Buffer.from(buf);
  };

  app.use(
    express.urlencoded({
      extended: false,
      verify: captureRawBody,
    }),
  );
  app.use(
    express.json({
      verify: captureRawBody,
    }),
  );

  // Liveness: process is up and listening (200 even when config degraded).
  app.get("/health", (_req, res) => {
    res.status(200).json({
      ...healthPayload(),
      liveness: true,
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

  const state = initRuntimeConfig();
  setLogLevel(state.config.MAILCALL_LOG_LEVEL);

  if (state.degraded) {
    console.warn(
      [
        "LOG: CONFIG DEGRADED — binding Express anyway (no process.exit).",
        ...state.degradeReasons.map((r) => `LOG:   reason: ${r}`),
        "LOG: Readiness probe /api/voice/mailcall/health will return 503 until fixed.",
      ].join("\n"),
    );
    logger.warn("mailcall_boot_degraded", {
      reasons: state.degradeReasons,
      envFilesLoaded: envLoadReport.loaded,
    });
  }

  const port = state.config.MAILCALL_PORT || DEFAULT_MAILCALL_PORT;
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
      degraded: state.degraded,
      inbound: `${MAILCALL_API_PREFIX}/inbound`,
      ws: `${MAILCALL_API_PREFIX}/ws`,
      envFilesLoaded: envLoadReport.loaded,
    });

    // Warm mem index + 5m SWR after bind — never blocks listen() or live turns.
    if (!state.degraded) {
      console.log("LOG: Starting WordPress in-memory cache warm + SWR...");
      startWordPressMemCache();
    } else {
      console.log("LOG: Skipping CMS cache warm while config is degraded.");
    }
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

  try {
    // Always bind — soft config issues → degraded + 503 readiness, not exit.
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
