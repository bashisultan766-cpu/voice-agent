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
import {
  ROUTING_DECIDE_PATH,
  ROUTING_FORWARD_PATH,
  ROUTING_GATHER_PATH,
  TWILIO_INBOUND_PATH,
} from "./paths.js";

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "voice-router",
      activeSessions: sessionCount(),
      twilioWebhook: TWILIO_INBOUND_PATH,
    });
  });

  // Original project Twilio webhook URL — do not change in Twilio Console.
  app.post(TWILIO_INBOUND_PATH, async (req, res) => {
    try {
      await handleInbound(req, res);
    } catch (err) {
      logger.error("router_inbound_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  app.post(ROUTING_GATHER_PATH, async (req, res) => {
    try {
      await handleGather(req, res);
    } catch (err) {
      logger.error("router_gather_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  app.post(ROUTING_FORWARD_PATH, async (req, res) => {
    try {
      await handleForwardToAgent(req, res);
    } catch (err) {
      logger.error("router_forward_endpoint_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  app.post(ROUTING_DECIDE_PATH, async (req, res) => {
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
      twilioWebhook: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}${TWILIO_INBOUND_PATH}`,
    });
  });
}

startServer();
