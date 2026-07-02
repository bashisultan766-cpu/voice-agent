import type { Request, Response } from "express";
import { getConfig, VOICE_PATH_PREFIX } from "../config.js";
import { getOrCreateCallSession } from "../memory/callSessionStore.js";
import { logger } from "../utils/logger.js";
import { validateTwilioSignature } from "../utils/twilioSignature.js";
import {
  buildErrorTwiml,
  buildGreetingResponse,
  clearCallResources,
  handleNoSpeechTurn,
  resolveCallerText,
  runBrainTurnAndBuildTwiml,
  synthesizeAndStore,
} from "./voiceTurnPipeline.js";
import { buildPlayGatherTwiml } from "./twimlBuilder.js";

function maskPhone(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

async function validateTwilio(req: Request): Promise<void> {
  const cfg = getConfig();
  await validateTwilioSignature(req, cfg.TWILIO_AUTH_TOKEN, cfg.VALIDATE_TWILIO_SIGNATURES, {
    routerForwardSecret: cfg.VOICE_ROUTER_FORWARD_SECRET,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
  });
}

export async function handleInboundCall(req: Request, res: Response): Promise<void> {
  await validateTwilio(req);

  const callSid = String(req.body.CallSid ?? "");
  const from = String(req.body.From ?? "unknown");
  const to = String(req.body.To ?? "unknown");
  const routerSpeech = String(req.body.RouterSpeech ?? "").trim();

  logger.info("inbound_call", {
    callSid: callSid.slice(0, 8),
    from: maskPhone(from),
    to: maskPhone(to),
    runtime: "elevenlabs_play",
    hasRouterSpeech: Boolean(routerSpeech),
  });

  getOrCreateCallSession(callSid, from, to);

  try {
    if (routerSpeech) {
      const session = getOrCreateCallSession(callSid, from, to);
      const fillerUrl = await synthesizeAndStore(
        "One moment while I look that up for you.",
        callSid,
      );
      const turnTwiml = await runBrainTurnAndBuildTwiml(session, routerSpeech);
      const audioUrls = extractPlayUrls(turnTwiml);
      const twiml = buildPlayGatherTwiml([fillerUrl, ...audioUrls]);
      res.type("application/xml").send(twiml);
      return;
    }

    const twiml = await buildGreetingResponse(callSid);
    res.type("application/xml").send(twiml);
  } catch (err) {
    logger.error("inbound_call_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    res.type("application/xml").send(await buildErrorTwiml(callSid));
  }
}

export async function handleTurn(req: Request, res: Response): Promise<void> {
  await validateTwilio(req);

  const callSid = String(req.body.CallSid ?? "");
  const from = String(req.body.From ?? "unknown");
  const to = String(req.body.To ?? "unknown");
  const speechResult = String(req.body.SpeechResult ?? "");
  const digits = String(req.body.Digits ?? "");

  logger.info("voice_turn", {
    callSid: callSid.slice(0, 8),
    hasSpeech: Boolean(speechResult.trim()),
    hasDigits: Boolean(digits.trim()),
  });

  try {
    const session = getOrCreateCallSession(callSid, from, to);
    const callerText = resolveCallerText(speechResult, digits);

    if (!callerText) {
      res.type("application/xml").send(await handleNoSpeechTurn(session));
      return;
    }

    const twiml = await runBrainTurnAndBuildTwiml(session, callerText);
    res.type("application/xml").send(twiml);
  } catch (err) {
    logger.error("voice_turn_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    res.type("application/xml").send(await buildErrorTwiml(callSid));
  }
}

export async function handleCallStatus(req: Request, res: Response): Promise<void> {
  await validateTwilio(req);

  const callSid = String(req.body.CallSid ?? "");
  const status = String(req.body.CallStatus ?? "");

  if (status === "completed" || status === "canceled" || status === "failed") {
    clearCallResources(callSid);
    logger.info("call_ended", { callSid: callSid.slice(0, 8), status });
  }

  res.status(200).send("");
}

/** Legacy relay-action — ConversationRelay removed. */
export async function handleRelayAction(req: Request, res: Response): Promise<void> {
  await validateTwilio(req);
  const callSid = String(req.body.CallSid ?? "");
  clearCallResources(callSid);
  res
    .type("application/xml")
    .send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
}

function extractPlayUrls(twiml: string): string[] {
  const urls: string[] = [];
  const re = /<Play>([^<]+)<\/Play>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(twiml)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

export { VOICE_PATH_PREFIX };
