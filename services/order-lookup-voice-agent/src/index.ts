import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { getConfig, VOICE_PATH_PREFIX, wsUrl } from "./config.js";
import { warmPhraseCache } from "./utils/phraseCache.js";
import { prewarmVoiceCache } from "./services/voiceService.js";
import { logger, setLogLevel } from "./utils/logger.js";
import { handleInboundCall, handleRelayAction } from "./voice/twilioWebhook.js";
import { handleConversationRelaySocket } from "./voice/streamHandler.js";

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "order-lookup-voice-agent",
      runtime: "twilio_conversation_relay",
      wsUrl: wsUrl(),
    });
  });

  app.post(`${VOICE_PATH_PREFIX}/inbound`, async (req, res) => {
    try {
      await handleInboundCall(req, res);
    } catch (err) {
      logger.error("inbound_call_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  app.post(`${VOICE_PATH_PREFIX}/relay-action`, async (req, res) => {
    try {
      await handleRelayAction(req, res);
    } catch (err) {
      logger.error("relay_action_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  // Legacy alias for direct testing without router.
  app.post("/voice/twilio/inbound", async (req, res) => {
    try {
      await handleInboundCall(req, res);
    } catch (err) {
      logger.error("inbound_call_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(403).send("Forbidden");
    }
  });

  return app;
}

export function startServer() {
  const cfg = getConfig();
  setLogLevel(cfg.LOG_LEVEL);
  warmPhraseCache();
  void prewarmVoiceCache();

  const app = createApp();
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: `${VOICE_PATH_PREFIX}/ws` });
  wss.on("connection", (socket) => {
    void handleConversationRelaySocket(socket);
  });

  server.listen(cfg.PORT, () => {
    logger.info("server_started", { port: cfg.PORT, wsUrl: wsUrl() });
  });

  return server;
}

startServer();
