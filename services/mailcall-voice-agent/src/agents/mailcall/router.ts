/**
 * Isolated Twilio voice router for Mail Call.
 * Mounted exclusively at /api/voice/mailcall — never shares paths with other agents.
 */

import { Router, type Request, type Response } from "express";
import type { WebSocket, WebSocketServer } from "ws";
import { getConfig, MAILCALL_API_PREFIX } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { validateTwilioSignature } from "../../utils/twilioSignature.js";
import {
  clearSession,
  greetingSpeech,
  processConversationTurn,
} from "./conversation.js";
import { WordPressApiClient } from "./wordpress_api.js";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function publicWsUrl(): string {
  const cfg = getConfig();
  const base = (cfg.MAILCALL_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) {
    throw new Error("MAILCALL_PUBLIC_BASE_URL is required for inbound TwiML");
  }
  const wsBase = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  return `${wsBase}${MAILCALL_API_PREFIX}/ws`;
}

function conversationRelayTwiml(welcome: string): string {
  const ws = escapeXml(publicWsUrl());
  const greeting = escapeXml(welcome);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${ws}" welcomeGreeting="${greeting}" />
  </Connect>
</Response>`;
}

function fallbackTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">We are experiencing technical difficulties. Please try again later.</Say>
</Response>`;
}

export function createMailCallRouter(): Router {
  const router = Router();

  /** Health for this agent namespace only. */
  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      agent: "mailcall",
      publication: "Mail Call Communication Newspaper",
      prefix: MAILCALL_API_PREFIX,
    });
  });

  /**
   * Twilio Voice webhook — point the Mail Call number here.
   * POST /api/voice/mailcall/inbound
   */
  router.post("/inbound", async (req: Request, res: Response) => {
    const cfg = getConfig();
    logger.info("mailcall_inbound_received", {
      callSid: req.body?.CallSid,
      from: req.body?.From,
      to: req.body?.To,
    });

    try {
      validateTwilioSignature(
        req,
        cfg.MAILCALL_TWILIO_AUTH_TOKEN,
        cfg.MAILCALL_VALIDATE_TWILIO_SIGNATURES,
        cfg.MAILCALL_PUBLIC_BASE_URL,
      );

      const to = String(req.body?.To ?? "");
      if (
        cfg.MAILCALL_TWILIO_PHONE_NUMBER &&
        to &&
        !to.replace(/\D/g, "").endsWith(cfg.MAILCALL_TWILIO_PHONE_NUMBER.replace(/\D/g, ""))
      ) {
        logger.warn("mailcall_inbound_number_mismatch", {
          expected: cfg.MAILCALL_TWILIO_PHONE_NUMBER,
          to,
        });
      }

      res.type("application/xml").send(conversationRelayTwiml(greetingSpeech()));
    } catch (err) {
      logger.error("mailcall_inbound_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.type("application/xml").status(200).send(fallbackTwiml());
    }
  });

  /**
   * JSON turn API for staging / harnesses (not required by Twilio).
   * POST /api/voice/mailcall/turn
   * Body: { callSid, utterance }
   */
  router.post("/turn", async (req: Request, res: Response) => {
    try {
      const callSid = String(req.body?.callSid ?? "local").trim();
      const utterance = String(req.body?.utterance ?? "").trim();
      const result = await processConversationTurn({ callSid, utterance });
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error("mailcall_turn_http_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(200).json({
        ok: true,
        speech: WordPressApiClient.unavailableSpeech(),
        degraded: true,
        articlesUsed: 0,
        latencyMs: 0,
      });
    }
  });

  return router;
}

interface RelayPromptMessage {
  type?: string;
  voicePrompt?: string;
  callSid?: string;
  last?: boolean;
}

/**
 * Attach ConversationRelay WebSocket handler to an existing WSS bound at
 * /api/voice/mailcall/ws.
 */
export function attachMailCallRelayHandler(wss: WebSocketServer): void {
  wss.on("connection", (socket: WebSocket) => {
    let callSid = "unknown";
    logger.info("mailcall_ws_connected");

    socket.on("message", async (raw) => {
      let msg: RelayPromptMessage;
      try {
        msg = JSON.parse(String(raw)) as RelayPromptMessage;
      } catch {
        logger.warn("mailcall_ws_bad_json");
        return;
      }

      if (msg.callSid) callSid = msg.callSid;

      if (msg.type === "setup") {
        logger.info("mailcall_ws_setup", { callSid });
        return;
      }

      if (msg.type === "prompt" && msg.voicePrompt) {
        try {
          const result = await processConversationTurn({
            callSid,
            utterance: msg.voicePrompt,
          });
          socket.send(
            JSON.stringify({
              type: "text",
              token: result.speech,
              last: true,
            }),
          );
          logger.info("mailcall_ws_turn", {
            callSid,
            degraded: result.degraded,
            articlesUsed: result.articlesUsed,
            latencyMs: result.latencyMs,
          });
        } catch (err) {
          logger.error("mailcall_ws_turn_failed", {
            callSid,
            error: err instanceof Error ? err.message : String(err),
          });
          socket.send(
            JSON.stringify({
              type: "text",
              token: WordPressApiClient.unavailableSpeech(),
              last: true,
            }),
          );
        }
        return;
      }

      if (msg.type === "error") {
        logger.error("mailcall_relay_error", { callSid, payload: msg });
      }
    });

    socket.on("close", () => {
      clearSession(callSid);
      logger.info("mailcall_ws_closed", { callSid });
    });

    socket.on("error", (err) => {
      logger.error("mailcall_ws_socket_error", {
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

export { MAILCALL_API_PREFIX } from "../../config.js";
