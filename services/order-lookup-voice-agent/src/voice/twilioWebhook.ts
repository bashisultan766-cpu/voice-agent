import type { Request, Response } from "express";
import { getConfig, VOICE_PATH_PREFIX, wsUrl } from "../config.js";
import { logger } from "../utils/logger.js";
import { buildConversationRelayVoiceAttrs } from "../services/voiceService.js";
import { validateTwilioSignature } from "../utils/twilioSignature.js";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function maskPhone(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

function renderConversationRelayTwiml(params: {
  wsUrl: string;
  callSid: string;
  from: string;
  to: string;
  welcomeGreeting: string;
  routerSpeech?: string;
}): string {
  const voiceAttrs = buildConversationRelayVoiceAttrs();
  const attrs = {
    url: params.wsUrl,
    action: `${getConfig().PUBLIC_BASE_URL.replace(/\/$/, "")}${VOICE_PATH_PREFIX}/relay-action`,
    method: "POST",
    welcomeGreeting: params.welcomeGreeting,
    welcomeGreetingInterruptible: "any",
    ...voiceAttrs,
  };

  const attrString = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeXml(v)}"`)
    .join(" ");

  return `${XML_HEADER}<Response><Connect><ConversationRelay ${attrString}><Parameter name="callSid" value="${escapeXml(params.callSid)}"/><Parameter name="from" value="${escapeXml(params.from)}"/><Parameter name="to" value="${escapeXml(params.to)}"/>${params.routerSpeech ? `<Parameter name="routerSpeech" value="${escapeXml(params.routerSpeech)}"/>` : ""}</ConversationRelay></Connect></Response>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function handleInboundCall(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  await validateTwilioSignature(req, cfg.TWILIO_AUTH_TOKEN, cfg.VALIDATE_TWILIO_SIGNATURES, {
    routerForwardSecret: cfg.VOICE_ROUTER_FORWARD_SECRET,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
  });

  const callSid = String(req.body.CallSid ?? "");
  const from = String(req.body.From ?? "unknown");
  const to = String(req.body.To ?? "unknown");

  logger.info("inbound_call", {
    callSid: callSid.slice(0, 8),
    from: maskPhone(from),
    to: maskPhone(to),
    wsUrl: wsUrl(),
    voice: buildConversationRelayVoiceAttrs().voice ?? "default",
  });

  const routerSpeech = String(req.body.RouterSpeech ?? "").trim();

  const welcomeGreeting = routerSpeech
    ? "One moment while I look up your order."
    : "Hello, thank you for calling SureShot Books. Please provide your order number.";

  const twiml = renderConversationRelayTwiml({
    wsUrl: wsUrl(),
    callSid,
    from,
    to,
    welcomeGreeting,
    routerSpeech: routerSpeech || undefined,
  });

  res.type("application/xml").send(twiml);
}

export async function handleRelayAction(req: Request, res: Response): Promise<void> {
  const cfg = getConfig();
  await validateTwilioSignature(req, cfg.TWILIO_AUTH_TOKEN, cfg.VALIDATE_TWILIO_SIGNATURES, {
    routerForwardSecret: cfg.VOICE_ROUTER_FORWARD_SECRET,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
  });

  const handoff = String(req.body.HandoffData ?? req.body.handoffData ?? "");
  const hangup = handoff.includes("caller_done") || /goodbye/i.test(handoff);

  const twiml = hangup
    ? `${XML_HEADER}<Response><Hangup/></Response>`
    : `${XML_HEADER}<Response></Response>`;

  res.type("application/xml").send(twiml);
}
