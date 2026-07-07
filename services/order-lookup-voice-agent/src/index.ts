import http from "node:http";

import express from "express";

import { WebSocketServer } from "ws";

import { getConfig, VOICE_PATH_PREFIX, wsUrl } from "./config.js";

import { warmPhraseCache } from "./utils/phraseCache.js";

import { prewarmVoiceCache } from "./services/voiceService.js";

import { logger, setLogLevel } from "./utils/logger.js";

import { handleInboundCall, handleRelayAction } from "./voice/twilioWebhook.js";

import { handleConversationRelaySocket } from "./voice/streamHandler.js";

import { initPostgresEventStore } from "./platform/postgresEventStore.js";

import { validateEnvironmentOnStartup } from "./platform/envValidator.js";

import {

  ensureVoiceProviderReady,

  initializeGlobalVoiceProvider,

} from "./adapters/voiceAdapter.js";



const CONVERSATION_BRAIN_INBOUND = "/conversationBrain/inbound";

export function createApp() {

  const app = express();

  app.set("trust proxy", true);

  app.use(express.urlencoded({ extended: false }));

  app.use(express.json());



  app.get("/health", (_req, res) => {

    const voiceReady = ensureVoiceProviderReady();

    res.json({

      ok: true,

      service: "order-lookup-voice-agent",

      runtime: "twilio_conversation_relay",

      wsUrl: wsUrl(),

      voiceProvider: voiceReady.ok ? voiceReady.provider : null,

      voiceProviderReady: voiceReady.ok,

    });

  });



  app.post(CONVERSATION_BRAIN_INBOUND, async (req, res) => {

    try {

      await handleInboundCall(req, res);

    } catch (err) {

      logger.error("conversation_brain_inbound_failed", {

        error: err instanceof Error ? err.message : String(err),

      });

      res

        .type("application/xml")

        .send(

          '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">We are experiencing technical difficulties. Please try again later.</Say></Response>',

        );

    }

  });



  app.post(`${VOICE_PATH_PREFIX}/relay-action`, async (req, res) => {

    try {

      await handleRelayAction(req, res);

    } catch (err) {

      logger.error("relay_action_failed", {

        error: err instanceof Error ? err.message : String(err),

      });

      res

        .type("application/xml")

        .send(

          '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong. Please try again.</Say></Response>',

        );

    }

  });



  return app;

}



export function startServer() {

  const cfg = getConfig();

  setLogLevel(cfg.LOG_LEVEL);

  warmPhraseCache();

  void initPostgresEventStore();



  const app = createApp();

  const server = http.createServer(app);



  const wss = new WebSocketServer({ server, path: `${VOICE_PATH_PREFIX}/ws` });

  wss.on("connection", (socket, req) => {

    const voiceReady = ensureVoiceProviderReady();

    if (!voiceReady.ok) {

      logger.error("relay_ws_rejected_voice_provider_uninitialized", {

        path: req.url,

        error: voiceReady.error,

      });

      socket.close(1011, "Voice provider unavailable");

      return;

    }



    logger.info("relay_ws_connected", {

      path: req.url,

      remote: req.socket.remoteAddress,

      voiceProvider: voiceReady.provider,

    });

    socket.on("error", (err) => {

      logger.error("relay_ws_socket_error", { error: err.message });

    });

    void handleConversationRelaySocket(socket);

  });



  server.listen(cfg.PORT, () => {

    const voiceReady = ensureVoiceProviderReady();

    logger.info("server_started", {

      port: cfg.PORT,

      service: "order-lookup-voice-agent",

      wsUrl: wsUrl(),

      inbound: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}${CONVERSATION_BRAIN_INBOUND}`,

      voiceProvider: voiceReady.ok ? voiceReady.provider : null,

    });

  });



  return server;

}



async function bootstrap(): Promise<void> {

  if (process.env.SKIP_SHOPIFY_STARTUP_CHECK !== "true") {

    await validateEnvironmentOnStartup();

  }



  const provider = await initializeGlobalVoiceProvider();

  logger.info("voice_provider_ready", { provider });

  await prewarmVoiceCache();

  startServer();

}



process.on("unhandledRejection", (reason) => {

  logger.error("unhandled_rejection", {

    error: reason instanceof Error ? reason.message : String(reason),

  });

});



bootstrap().catch((err) => {

  logger.error("startup_failed", {

    error: err instanceof Error ? err.message : String(err),

  });

  process.exit(1);

});


