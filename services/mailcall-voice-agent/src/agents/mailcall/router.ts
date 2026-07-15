/**
 * Isolated Twilio voice router for Mail Call.
 * Mounted exclusively at /api/voice/mailcall — never shares paths with other agents.
 */

import { Router, type Request, type Response } from "express";
import type { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_MAILCALL_PUBLIC_BASE_URL,
  getConfig,
  getDegradeReasons,
  isConfigDegraded,
  MAILCALL_API_PREFIX,
  type MailCallConfig,
} from "../../config.js";
import { logger } from "../../utils/logger.js";
import { validateTwilioSignature } from "../../utils/twilioSignature.js";
import {
  clearSession,
  greetingSpeech,
  processConversationTurn,
} from "./conversation.js";
import { WordPressApiClient } from "./wordpress_api.js";

/** Known production host for this deployment (used when env is unset). */
const DEFAULT_PUBLIC_BASE_URL = DEFAULT_MAILCALL_PUBLIC_BASE_URL;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Resolve the HTTPS origin Twilio should use for ConversationRelay + signature URL.
 * Order: env → request forwarded headers → hard-coded production host.
 */
export function resolvePublicBaseUrl(req?: Request, cfg: MailCallConfig = getConfig()): string {
  const fromEnv = (cfg.MAILCALL_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  if (fromEnv) return fromEnv;

  if (req) {
    const proto = String(req.header("x-forwarded-proto") ?? req.protocol ?? "https")
      .split(",")[0]!
      .trim();
    const host = String(req.header("x-forwarded-host") ?? req.get("host") ?? "")
      .split(",")[0]!
      .trim();
    if (host) {
      const scheme = proto === "http" ? "http" : "https";
      return `${scheme}://${host}`.replace(/\/$/, "");
    }
  }

  return DEFAULT_PUBLIC_BASE_URL;
}

function publicWsUrl(req?: Request): string {
  const base = resolvePublicBaseUrl(req);
  const wsBase = base.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  return `${wsBase}${MAILCALL_API_PREFIX}/ws`;
}

function conversationRelayTwiml(welcome: string, req?: Request): string {
  const ws = escapeXml(publicWsUrl(req));
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

/**
 * Signature checks need the Twilio auth token. If validation is on but the token
 * is empty, skip validation (log loudly) instead of killing the call with fallback Say.
 */
function shouldValidateTwilioSignature(cfg: MailCallConfig): boolean {
  if (!cfg.MAILCALL_VALIDATE_TWILIO_SIGNATURES) return false;
  if (!cfg.MAILCALL_TWILIO_AUTH_TOKEN?.trim()) {
    logger.warn("mailcall_signature_skipped_missing_auth_token", {
      hint: "Set MAILCALL_TWILIO_AUTH_TOKEN or MAILCALL_VALIDATE_TWILIO_SIGNATURES=false",
    });
    return false;
  }
  return true;
}

export function createMailCallRouter(): Router {
  const router = Router();

  /** Readiness — 503 while config is degraded (liveness remains on GET /health). */
  router.get("/health", (_req, res) => {
    const degraded = isConfigDegraded();
    res.status(degraded ? 503 : 200).json({
      ok: !degraded,
      degraded,
      agent: "mailcall",
      publication: "Mail Call Communication Newspaper",
      prefix: MAILCALL_API_PREFIX,
      reasons: degraded ? getDegradeReasons() : [],
      message: degraded
        ? "Configuration degraded — fix MAILCALL_* env and restart"
        : "ok",
    });
  });

  /**
   * Twilio Voice webhook — point the Mail Call number here.
   * POST /api/voice/mailcall/inbound
   */
  router.post("/inbound", async (req: Request, res: Response) => {
    const cfg = getConfig();
    const publicBaseUrl = resolvePublicBaseUrl(req, cfg);
    const wsUrl = publicWsUrl(req);

    logger.info("mailcall_inbound_received", {
      callSid: req.body?.CallSid,
      from: req.body?.From,
      to: req.body?.To,
      publicBaseUrl,
      wsUrl,
      degraded: isConfigDegraded(),
      signatureStrict: cfg.MAILCALL_TWILIO_SIGNATURE_STRICT,
      hasRawBody: Boolean(req.rawBody?.length),
    });

    try {
      // Signature mismatch must NOT drop live calls by default (proxy/token drift).
      // Set MAILCALL_TWILIO_SIGNATURE_STRICT=true only after validation is proven.
      if (shouldValidateTwilioSignature(cfg)) {
        try {
          validateTwilioSignature(
            req,
            cfg.MAILCALL_TWILIO_AUTH_TOKEN,
            true,
            publicBaseUrl,
          );
          logger.info("mailcall_signature_ok", { callSid: req.body?.CallSid });
        } catch (sigErr) {
          const message = sigErr instanceof Error ? sigErr.message : String(sigErr);
          if (cfg.MAILCALL_TWILIO_SIGNATURE_STRICT) {
            throw sigErr;
          }
          logger.warn("mailcall_signature_soft_fail", {
            callSid: req.body?.CallSid,
            error: message,
            publicBaseUrl,
            hint: "Call continues with ConversationRelay. Fix MAILCALL_TWILIO_AUTH_TOKEN or set MAILCALL_VALIDATE_TWILIO_SIGNATURES=false. Enable STRICT only when signatures pass.",
          });
        }
      }

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

      const twiml = conversationRelayTwiml(greetingSpeech(), req);
      logger.info("mailcall_inbound_twiml_ok", { callSid: req.body?.CallSid, wsUrl });
      res.type("text/xml").send(twiml);
    } catch (err) {
      logger.error("mailcall_inbound_failed", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        publicBaseUrl,
        wsUrl,
        validateSignatures: shouldValidateTwilioSignature(cfg),
        hasAuthToken: Boolean(cfg.MAILCALL_TWILIO_AUTH_TOKEN?.trim()),
      });
      res.type("text/xml").status(200).send(fallbackTwiml());
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
          if (result.transferToNumber) {
            // ConversationRelay handoff — inbound TwiML action may Dial this number.
            socket.send(
              JSON.stringify({
                type: "end",
                handoffData: JSON.stringify({
                  action: "transfer_to_number",
                  number: result.transferToNumber,
                }),
              }),
            );
            logger.info("mailcall_ws_transfer", {
              callSid,
              // Do not log full number in shared logs if preferred — keep short.
              numberSuffix: result.transferToNumber.slice(-4),
            });
          }
          logger.info("mailcall_ws_turn", {
            callSid,
            degraded: result.degraded,
            articlesUsed: result.articlesUsed,
            latencyMs: result.latencyMs,
            transfer: Boolean(result.transferToNumber),
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
