import express from "express";
import { getConfig } from "./config.js";
import { logger, setLogLevel } from "./utils/logger.js";
import {
  handleDecide,
  handleForwardToAgent,
  handleGather,
  handleInbound,
} from "./voice-router/twilioInboundRouter.js";
import { sessionCount } from "./voice-router/sessionStore.js";

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "voice-router",
      activeSessions: sessionCount(),
    });
  });

  app.post("/voice-router/twilio/inbound", async (req, res) => {
    try {
      await handleInbound(req, res);
    } catch (err) {
      logger.error("router_inbound_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  app.post("/voice-router/twilio/gather", async (req, res) => {
    try {
      await handleGather(req, res);
    } catch (err) {
      logger.error("router_gather_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  app.post("/voice-router/forward-to-agent", async (req, res) => {
    try {
      await handleForwardToAgent(req, res);
    } catch (err) {
      logger.error("router_forward_endpoint_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  app.post("/voice-router/decide", async (req, res) => {
    try {
      await handleDecide(req, res);
    } catch (err) {
      logger.error("router_decide_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "decision_failed" });
    }
  });

  return app;
}

export function startServer() {
  const cfg = getConfig();
  setLogLevel(cfg.LOG_LEVEL);
  const app = createApp();

  app.listen(cfg.PORT, () => {
    logger.info("voice_router_started", {
      port: cfg.PORT,
      publicEntry: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/voice-router/twilio/inbound`,
    });
  });
}

startServer();
