import http from "node:http";
import express from "express";
import { getConfig, VOICE_PATH_PREFIX } from "./config.js";
import { getAudioFile, purgeExpiredAudio } from "./audio/audioManager.js";
import { warmPhraseCache } from "./utils/phraseCache.js";
import { prewarmVoiceCache } from "./services/voiceService.js";
import { logger, setLogLevel } from "./utils/logger.js";
import {
  handleCallStatus,
  handleInboundCall,
  handleRelayAction,
  handleTurn,
} from "./voice/twilioWebhook.js";
import { buildErrorTwiml } from "./voice/voiceTurnPipeline.js";

const CONVERSATION_BRAIN_INBOUND = "/conversationBrain/inbound";

export function createApp() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "order-lookup-voice-agent",
      runtime: "elevenlabs_play",
      tts: "elevenlabs_direct",
      inbound: `${getConfig().PUBLIC_BASE_URL.replace(/\/$/, "")}${VOICE_PATH_PREFIX}/inbound`,
    });
  });

  app.get(`${VOICE_PATH_PREFIX}/audio/:id.mp3`, async (req, res) => {
    try {
      const id = String(req.params.id ?? "").replace(/\.mp3$/, "");
      const audio = await getAudioFile(id);
      if (!audio) {
        res.status(404).send("Not found");
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(audio);
    } catch (err) {
      logger.error("audio_serve_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).send("Error");
    }
  });

  const inboundHandler = async (req: express.Request, res: express.Response) => {
    try {
      await handleInboundCall(req, res);
    } catch (err) {
      logger.error("inbound_call_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.type("application/xml").send(await buildErrorTwiml(String(req.body?.CallSid ?? "")));
    }
  };

  app.post(CONVERSATION_BRAIN_INBOUND, inboundHandler);
  app.post(`${VOICE_PATH_PREFIX}/inbound`, inboundHandler);
  app.post(`${VOICE_PATH_PREFIX}/turn`, async (req, res) => {
    try {
      await handleTurn(req, res);
    } catch (err) {
      logger.error("turn_handler_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.type("application/xml").send(await buildErrorTwiml(String(req.body?.CallSid ?? "")));
    }
  });

  app.post(`${VOICE_PATH_PREFIX}/status`, async (req, res) => {
    try {
      await handleCallStatus(req, res);
    } catch (err) {
      logger.error("call_status_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).send("");
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
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }
  });

  return app;
}

export function startServer() {
  const cfg = getConfig();
  setLogLevel(cfg.LOG_LEVEL);
  warmPhraseCache();
  void prewarmVoiceCache();
  void purgeExpiredAudio();
  setInterval(() => void purgeExpiredAudio(), 15 * 60 * 1000);

  const app = createApp();
  const server = http.createServer(app);

  server.listen(cfg.PORT, () => {
    logger.info("server_started", {
      port: cfg.PORT,
      service: "order-lookup-voice-agent",
      runtime: "elevenlabs_play",
      inbound: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}${VOICE_PATH_PREFIX}/inbound`,
      turn: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}${VOICE_PATH_PREFIX}/turn`,
      audio: `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}${VOICE_PATH_PREFIX}/audio/{id}.mp3`,
    });
  });

  return server;
}

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

startServer();
