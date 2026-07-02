import type { Request, Response } from "express";
import { getConfig, routerBaseUrl } from "../config.js";
import { routingForwardUrl, routingGatherUrl } from "../paths.js";
import { logger } from "../utils/logger.js";
import { validateTwilioSignature } from "../utils/twilioSignature.js";
import { decideRoute, isForwardTarget } from "./decisionEngine.js";
import { forwardToAgent } from "./agentForwarder.js";
import { getSession, lockSession } from "./sessionStore.js";

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
    res.type("application/xml").send(gatherTwiml(gatherUrl, true));
    return;
  }

  const decision = await decideRoute({
    speech,
    callSid,
    from: body.From,
  });

  logger.info("router_decision", {
    callSid: callSid.slice(0, 8),
    target: decision.target,
    intent: decision.intent,
    reason: decision.reason,
    confidence: decision.confidence,
    speechPreview: speech.slice(0, 80),
  });

  if (!isForwardTarget(decision.target)) {
    res
      .type("application/xml")
      .send(conversationalGatherTwiml(gatherUrl, decision.responseText ?? ROUTER_GREETING));
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

    if (session.target === "order_lookup") {
      lockSession(callSid, "main_agent", `forward_error_fallback:${session.reason}`, session.speech);
      try {
        const fallback = await forwardToAgent("main_agent", body, {
          callSid,
          reason: "forward_error_fallback",
          initialSpeech: session.speech,
        });
        res.type("application/xml").send(fallback.twiml);
        return;
      } catch (fallbackErr) {
        logger.error("router_fallback_failed", {
          callSid: callSid.slice(0, 8),
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    }

    res.type("application/xml").send(
      `${XML_HEADER}<Response><Say>We are experiencing technical difficulties. Please try again later.</Say><Hangup/></Response>`,
    );
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
    responseText: decision.responseText,
    forwardPath:
      decision.target === "order_lookup"
        ? "/voice/order/twilio/inbound"
        : decision.target === "main_agent"
          ? "/voice/twilio/agent/inbound"
          : null,
  });
}
