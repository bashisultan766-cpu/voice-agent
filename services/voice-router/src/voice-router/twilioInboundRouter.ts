import type { Request, Response } from "express";
import { getConfig, routerBaseUrl } from "../config.js";
import { routingForwardUrl, routingGatherUrl } from "../paths.js";
import { logger } from "../utils/logger.js";
import { validateTwilioSignature } from "../utils/twilioSignature.js";
import { VOICE_ROUTER_ERROR_TWIML } from "../utils/twilioFallback.js";
import { isSafeMode } from "../utils/safeMode.js";
import { decideRoute, isForwardTarget } from "./decisionEngine.js";
import { forwardToAgent } from "./agentForwarder.js";
import { getSession, lockSession } from "./sessionStore.js";
import { generateConversationResponse } from "./agents/conversationBrainAgent.js";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const ROUTER_GREETING =
  "Welcome to SureShot Books. Please tell me your order number, or say how I can help.";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function maskPhone(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

function gatherTwiml(actionUrl: string, reprompt = false): string {
  const cfg = getConfig();
  const sayText = reprompt
    ? "I didn't hear anything. Please tell me your order number, or say how I can help."
    : ROUTER_GREETING;

  return `${XML_HEADER}<Response><Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" timeout="${cfg.GATHER_TIMEOUT_SECS}" language="en-US"><Say>${escapeXml(sayText)}</Say></Gather><Redirect method="POST">${escapeXml(actionUrl)}</Redirect></Response>`;
}

function conversationalGatherTwiml(actionUrl: string, sayText: string): string {
  const cfg = getConfig();
  return `${XML_HEADER}<Response><Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" timeout="${cfg.GATHER_TIMEOUT_SECS}" language="en-US"><Say>${escapeXml(sayText)}</Say></Gather><Redirect method="POST">${escapeXml(actionUrl)}</Redirect></Response>`;
}

function redirectTwiml(url: string): string {
  return `${XML_HEADER}<Response><Redirect method="POST">${escapeXml(url)}</Redirect></Response>`;
}

function twilioBody(req: Request): Record<string, string> {
  const body = req.body as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    out[key] = String(value ?? "");
  }
  return out;
}

async function validateInbound(req: Request): Promise<void> {
  const cfg = getConfig();
  await validateTwilioSignature(req, cfg.TWILIO_AUTH_TOKEN, cfg.VALIDATE_TWILIO_SIGNATURES);
}

export async function handleInbound(req: Request, res: Response): Promise<void> {
  await validateInbound(req);

  const body = twilioBody(req);
  const callSid = body.CallSid ?? "";
  const from = body.From ?? "unknown";
  const to = body.To ?? "unknown";

  logger.info("router_inbound", {
    callSid: callSid.slice(0, 8),
    from: maskPhone(from),
    to: maskPhone(to),
  });

  const existing = getSession(callSid);
  if (existing) {
    logger.info("router_session_reuse", {
      callSid: callSid.slice(0, 8),
      target: existing.target,
      reason: existing.reason,
    });
    const forwardUrl = routingForwardUrl(routerBaseUrl());
    res.type("application/xml").send(redirectTwiml(forwardUrl));
    return;
  }

  const gatherUrl = routingGatherUrl(routerBaseUrl());
  res.type("application/xml").send(gatherTwiml(gatherUrl));
}

export async function handleGather(req: Request, res: Response): Promise<void> {
  await validateInbound(req);

  const body = twilioBody(req);
  const callSid = body.CallSid ?? "";
  const speech = (body.SpeechResult ?? body.UnstableSpeechResult ?? "").trim();
  const gatherUrl = routingGatherUrl(routerBaseUrl());

  if (!speech) {
    logger.info("router_no_speech_reprompt", { callSid: callSid.slice(0, 8) });
    try {
      const brainReply = await generateConversationResponse({
        callSid,
        userMessage: "",
        inferredIntent: "unknown",
      });
      res.type("application/xml").send(conversationalGatherTwiml(gatherUrl, brainReply));
    } catch (err) {
      logger.error("router_no_speech_brain_failed", {
        callSid: callSid.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      res.type("application/xml").send(conversationalGatherTwiml(gatherUrl, ROUTER_GREETING));
    }
    return;
  }

  let decision;
  try {
    decision = await decideRoute({
      speech,
      callSid,
      from: body.From,
    });
  } catch (err) {
    logger.error("router_decide_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    decision = {
      target: "conversation_brain" as const,
      intent: "unknown" as const,
      confidence: 0,
      reason: "decide_error_fallback",
    };
  }

  logger.info("router_decision", {
    callSid: callSid.slice(0, 8),
    target: decision.target,
    intent: decision.intent,
    reason: decision.reason,
    confidence: decision.confidence,
    speechPreview: speech.slice(0, 80),
    safeMode: isSafeMode(),
  });
  console.log("ROUTE:", decision.target);

  if (!isForwardTarget(decision.target) || isSafeMode()) {
    try {
      const brainReply = await generateConversationResponse({
        callSid,
        userMessage: speech,
        inferredIntent: decision.intent,
      });
      res.type("application/xml").send(conversationalGatherTwiml(gatherUrl, brainReply));
    } catch (err) {
      logger.error("router_brain_failed", {
        callSid: callSid.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      res.type("application/xml").send(conversationalGatherTwiml(gatherUrl, ROUTER_GREETING));
    }
    return;
  }

  lockSession(callSid, decision.target, decision.reason, speech);

  const forwardUrl = routingForwardUrl(routerBaseUrl());
  res.type("application/xml").send(redirectTwiml(forwardUrl));
}

export async function handleForwardToAgent(req: Request, res: Response): Promise<void> {
  await validateInbound(req);

  const body = twilioBody(req);
  const callSid = body.CallSid ?? "";
  const session = getSession(callSid);

  if (!session) {
    logger.warn("router_forward_missing_session", { callSid: callSid.slice(0, 8) });
    const gatherUrl = routingGatherUrl(routerBaseUrl());
    res.type("application/xml").send(gatherTwiml(gatherUrl, true));
    return;
  }

  try {
    const result = await forwardToAgent(session.target, body, {
      callSid,
      reason: session.reason,
      initialSpeech: session.speech,
    });

    if (result.fallbackUsed && result.target !== session.target) {
      lockSession(callSid, result.target, `fallback:${session.reason}`, session.speech);
    }

    res.type("application/xml").send(result.twiml);
  } catch (err) {
    logger.error("router_forward_failed", {
      callSid: callSid.slice(0, 8),
      target: session.target,
      error: err instanceof Error ? err.message : String(err),
    });
    console.log("ERROR:", err instanceof Error ? err.stack : String(err));
    res.type("application/xml").send(VOICE_ROUTER_ERROR_TWIML);
  }
}

export async function handleDecide(req: Request, res: Response): Promise<void> {
  const { speech, callSid, from } = req.body as {
    speech?: string;
    callSid?: string;
    from?: string;
  };

  if (!callSid) {
    res.status(400).json({ error: "callSid is required" });
    return;
  }

  const decision = await decideRoute({
    speech: speech ?? "",
    callSid,
    from,
  });

  logger.info("router_decide_api", {
    callSid: callSid.slice(0, 8),
    target: decision.target,
    reason: decision.reason,
    confidence: decision.confidence,
  });

  res.json({
    target: decision.target,
    intent: decision.intent,
    reason: decision.reason,
    confidence: decision.confidence,
    forwardPath: decision.target === "order_lookup" ? "/voice/order/twilio/inbound" : null,
  });
}
