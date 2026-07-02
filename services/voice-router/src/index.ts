import express from "express";
import type { Request, Response } from "express";
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
import { logTwilioError, logTwilioInput, sendTwilioError } from "./utils/twilioFallback.js";

type TwilioHandler = (req: Request, res: Response) => Promise<void>;

function wrapTwilioEndpoint(route: string, handler: TwilioHandler): TwilioHandler {
  return async (req, res) => {
    logTwilioInput(req, route);
    try {
      await handler(req, res);
    } catch (error) {
      logTwilioError(error);
      logger.error("voice_router_endpoint_crash", {
        route,
        error: error instanceof Error ? error.message : String(error),
      });
      sendTwilioError(res);
    }
  };
}

export function createApp() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "voice-router",
      activeSessions: sessionCount(),
      twilioWebhook: TWILIO_INBOUND_PATH,
      safeMode: getConfig().SAFE_MODE,
    });
  });

  app.post(TWILIO_INBOUND_PATH, wrapTwilioEndpoint("inbound", handleInbound));
  app.post(ROUTING_GATHER_PATH, wrapTwilioEndpoint("gather", handleGather));
  app.post(ROUTING_FORWARD_PATH, wrapTwilioEndpoint("forward", handleForwardToAgent));

  app.post(ROUTING_DECIDE_PATH, async (req, res) => {
    logTwilioInput(req, "decide");
    try {
      await handleDecide(req, res);
    } catch (error) {
      logTwilioError(error);
      if (!res.headersSent) {
        res.status(500).json({ error: "decision_failed", target: "conversation_brain" });
      }
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
      safeMode: cfg.SAFE_MODE,
      twilioWebhook: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}${TWILIO_INBOUND_PATH}`,
    });
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("VOICE ROUTER UNHANDLED REJECTION:", reason);
  logger.error("voice_router_unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

startServer();
