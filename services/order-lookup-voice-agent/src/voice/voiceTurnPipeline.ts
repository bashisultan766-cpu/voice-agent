/**
 * Twilio voice turn pipeline — brain → ElevenLabs → TwiML Play.
 * Twilio never generates speech; all audio comes from ElevenLabs MP3s.
 */
import { BRAIN_GREETING, streamBrainTurn } from "../agents/conversationBrain.js";
import { saveAudio } from "../audio/audioManager.js";
import { clearCallExecutionPhase } from "../guards/toolExecutionGuard.js";
import { clearCallMemory } from "../memory/callMemoryStore.js";
import { clearCallSession, saveCallSession } from "../memory/callSessionStore.js";
import { clearCallState } from "../memory/callStateStore.js";
import { clearCustomerMemory } from "../memory/customerMemoryStore.js";
import { logger } from "../utils/logger.js";
import { synthesizeSpeech } from "./tts/elevenlabs.js";
import {
  buildGreetingTwiml,
  buildHangupTwiml,
  buildNoInputTwiml,
  buildPlayGatherTwiml,
} from "./twimlBuilder.js";
import type { CallSession } from "../types/order.js";

const NO_INPUT_REPROMPT =
  "I'm still here. You can ask about a book or give me your order number.";
const ERROR_SPEECH =
  "Sorry, we're having a brief technical issue. Please try again in a moment.";
const TECHNICAL_DIFFICULTIES =
  "We are experiencing technical difficulties. Please try again later.";

export async function synthesizeAndStore(
  text: string,
  callSid?: string,
): Promise<string> {
  const result = await synthesizeSpeech(text);
  const stored = await saveAudio(result.audio, callSid);
  return stored.url;
}

export async function buildGreetingResponse(callSid: string): Promise<string> {
  const url = await synthesizeAndStore(BRAIN_GREETING, callSid);
  return buildGreetingTwiml(url);
}

export async function runBrainTurnAndBuildTwiml(
  session: CallSession,
  callerText: string,
): Promise<string> {
  const speechParts: string[] = [];
  let endCall = false;

  for await (const event of streamBrainTurn(session, callerText)) {
    if (event.type === "chunk") {
      speechParts.push(event.chunk.text);
    }
    if (event.type === "done") {
      endCall = event.endCall ?? false;
      session.phase = event.phase;
    }
  }

  saveCallSession(session);

  const fullSpeech = speechParts.join(" ").trim();
  if (!fullSpeech) {
    const repromptUrl = await synthesizeAndStore(NO_INPUT_REPROMPT, session.callSid);
    return buildNoInputTwiml(repromptUrl);
  }

  const audioUrl = await synthesizeAndStore(fullSpeech, session.callSid);

  if (endCall || session.phase === "ended") {
    clearCallResources(session.callSid);
    return buildHangupTwiml([audioUrl]);
  }

  return buildPlayGatherTwiml([audioUrl]);
}

export async function buildErrorTwiml(callSid?: string): Promise<string> {
  try {
    const url = await synthesizeAndStore(ERROR_SPEECH, callSid);
    return buildPlayGatherTwiml([url]);
  } catch {
    try {
      const url = await synthesizeAndStore(TECHNICAL_DIFFICULTIES, callSid);
      return buildHangupTwiml([url]);
    } catch {
      logger.error("elevenlabs_error_fallback_exhausted");
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
    }
  }
}

export function clearCallResources(callSid: string): void {
  clearCallMemory(callSid);
  clearCallExecutionPhase(callSid);
  clearCallState(callSid);
  clearCustomerMemory(callSid);
  clearCallSession(callSid);
}

export async function handleNoSpeechTurn(session: CallSession): Promise<string> {
  const repromptUrl = await synthesizeAndStore(NO_INPUT_REPROMPT, session.callSid);
  return buildNoInputTwiml(repromptUrl);
}

export function resolveCallerText(
  speechResult: string,
  digits?: string,
): string {
  const speech = (speechResult ?? "").trim();
  if (speech) return speech;
  return (digits ?? "").trim();
}
