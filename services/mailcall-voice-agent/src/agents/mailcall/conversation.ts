/**
 * Conversational turn engine for Brook:
 * policy fast-paths → CMS retrieve → optional LLM + tools → speech-safe 2–3 sentences.
 */

import OpenAI from "openai";
import { getConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { getWordPressApiClient, type WordPressApiClient } from "./wordpress_api.js";
import {
  brandOfflineFallbackSpeech,
  brandProfile,
  offTopicRedirectSpeech,
} from "./brandProfile.js";
import {
  buildProductCatalogSpeech,
  findPlanByUtterance,
  SCRIPTS,
} from "./businessRules.js";
import {
  buildRetrievalOnlySpeech,
  buildTurnMessages,
} from "./prompts.js";
import {
  executeMailCallTool,
  MAILCALL_TOOL_DEFINITIONS,
  normalizeNewspaperSelection,
  normalizePhoneNumber,
  normalizePlanDuration,
  type PrintPlanIntake,
} from "./tools.js";
import { looksLikeEmail, normalizeSpokenEmail } from "./emailNormalize.js";
import { clampSpokenLength, truncateToSentences } from "./textCleaner.js";
import type { CallTurnResult } from "./types.js";
import { GREETING_SPEECH } from "./types.js";

export interface ConversationTurnInput {
  callSid: string;
  utterance: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Telephony metadata is accepted for observability only, never corporate geolocation. */
  callerPhone?: string;
  callerCountryCode?: string;
  networkGeolocation?: string;
}

interface SessionMemory {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  startedAtMs: number;
  printIntake?: PrintIntakeState;
}

type IntakeSlot = keyof PrintPlanIntake;

interface PrintIntakeState {
  active: boolean;
  slots: Partial<PrintPlanIntake>;
  awaiting?: IntakeSlot;
}

type MailCallToolExecutor = typeof executeMailCallTool;

const sessions = new Map<string, SessionMemory>();

const OFF_TOPIC_RE =
  /\b(python|javascript|code|program(ming)?|cook(ing)?|recipe|bitcoin|crypto|weather forecast|homework|math problem)\b/i;

const PRICING_RE =
  /\b(price|pricing|plan|plans|cost|how much|subscription|what('s| is) included|sections?)\b/i;

const REFUND_RE = /\b(refund|cancel(lation|ling)?|return(s)?|money back|credit)\b/i;

const ADDRESS_CHANGE_RE =
  /\b(address change|change (of )?address|moved|inmate moved|new facility|forward(ing)?)\b/i;

const DELAY_RE =
  /\b(delay(ed)?|late|hasn'?t (arrived|come)|not (received|gotten)|where is (my|the) (paper|issue|order))\b/i;

const UPSET_RE = /\b(angry|furious|ridiculous|unacceptable|scam|lawsuit|attorney)\b/i;

/** Structural WordPress page intents bypass regular article retrieval. */
const CORPORATE_IDENTITY_RE =
  /\b(address|location|office|ceo|owner|meet|contact|advertis(?:e|ing))\b/i;

const CORPORATE_HEADQUARTERS_RE =
  /\b(your|mailcall|newspaper|corporate|headquarters|office|editorial)\b.*\b(address|location|located|based)\b|\bwhere (is|are)\b.*\b(mailcall|newspaper|headquarters|office|editorial)\b/i;

const PURCHASE_INTENT_RE =
  /\b(buy|purchase|subscribe|subscription setup|sign me up|sign up|set up|start)\b.*\b(plan|subscription|newspaper|mailcall|edition)\b|\b(i want|i'd like|i would like|ready)\b.*\b(subscribe|subscription|buy|purchase|plan|edition)\b/i;

const INTAKE_SLOT_ORDER: IntakeSlot[] = [
  "sender_name",
  "sender_email",
  "sender_phone",
  "inmate_name",
  "inmate_number",
  "facility_name",
  "facility_address",
  "newspaper_selection",
  "plan_duration",
];

const INTAKE_PROMPTS: Record<IntakeSlot, string> = {
  sender_name: "I can help with that. What is your full name?",
  sender_email:
    "Got it. What is your email address? You can say “at” for the at sign and “dot” for each period.",
  sender_phone:
    "Got it. Before I submit this to our fulfillment team, what is your preferred contact phone number?",
  inmate_name: "Thank you. What is the inmate's full legal name?",
  inmate_number: "Got it. What is the inmate's booking or identification number?",
  facility_name: "Thank you. What is the official name of the correctional facility?",
  facility_address:
    "Got it. What is the complete physical shipping address for that facility?",
  newspaper_selection:
    "Which print edition would you like: Urban, Spanish, or Global?",
  plan_duration:
    "Which plan duration would you like: one, three, six, or twelve months?",
};

function cleanSpokenValue(raw: string): string {
  return raw
    .trim()
    .replace(
      /^(?:it(?:'s| is)|this is|my (?:full )?name is|the (?:inmate|facility)(?:'s)? (?:name|number|address) is)\s+/i,
      "",
    )
    .trim();
}

function captureIntakeSlot(
  intake: PrintIntakeState,
  slot: IntakeSlot,
  utterance: string,
): { accepted: boolean; retrySpeech?: string } {
  const value = cleanSpokenValue(utterance);
  switch (slot) {
    case "sender_email": {
      const email = normalizeSpokenEmail(value);
      if (!looksLikeEmail(email)) {
        return {
          accepted: false,
          retrySpeech:
            "I want to make sure I have that correctly. Please say your email slowly, using “at” for the at sign and “dot” for each period.",
        };
      }
      intake.slots.sender_email = email;
      break;
    }
    case "sender_phone": {
      const phone = normalizePhoneNumber(value);
      if (!phone) {
        return {
          accepted: false,
          retrySpeech:
            "I didn't get a complete phone number. Please repeat your preferred contact number, including the area code.",
        };
      }
      intake.slots.sender_phone = phone;
      break;
    }
    case "newspaper_selection": {
      const selection = normalizeNewspaperSelection(value);
      if (!selection) {
        return {
          accepted: false,
          retrySpeech: "Please choose one edition: Urban, Spanish, or Global.",
        };
      }
      intake.slots.newspaper_selection = selection;
      break;
    }
    case "plan_duration": {
      const duration = normalizePlanDuration(value);
      if (!duration) {
        return {
          accepted: false,
          retrySpeech: "Please choose a one, three, six, or twelve month plan.",
        };
      }
      intake.slots.plan_duration = duration;
      break;
    }
    default:
      if (value.length < 2) {
        return { accepted: false, retrySpeech: INTAKE_PROMPTS[slot] };
      }
      intake.slots[slot] = value;
  }
  intake.awaiting = undefined;
  return { accepted: true };
}

function nextMissingIntakeSlot(intake: PrintIntakeState): IntakeSlot | undefined {
  return INTAKE_SLOT_ORDER.find((slot) => {
    const value = intake.slots[slot];
    return value === undefined || value === "";
  });
}

function prefillIntakeSelections(intake: PrintIntakeState, utterance: string): void {
  const selection = normalizeNewspaperSelection(utterance);
  const duration = normalizePlanDuration(utterance);
  if (selection) intake.slots.newspaper_selection = selection;
  if (duration) intake.slots.plan_duration = duration;
}

function isCompletePrintPlanIntake(
  slots: Partial<PrintPlanIntake>,
): slots is PrintPlanIntake {
  return INTAKE_SLOT_ORDER.every((slot) => slots[slot] !== undefined && slots[slot] !== "");
}

async function processPrintIntake(
  session: SessionMemory,
  callSid: string,
  utterance: string,
  toolExecutor: MailCallToolExecutor,
): Promise<string | null> {
  const beginsNow = !session.printIntake?.active && PURCHASE_INTENT_RE.test(utterance);
  if (beginsNow) {
    session.printIntake = { active: true, slots: {} };
    prefillIntakeSelections(session.printIntake, utterance);
  }

  const intake = session.printIntake;
  if (!intake?.active) return null;

  if (!beginsNow && intake.awaiting) {
    const captured = captureIntakeSlot(intake, intake.awaiting, utterance);
    if (!captured.accepted) return captured.retrySpeech ?? INTAKE_PROMPTS[intake.awaiting];
  }

  const missing = nextMissingIntakeSlot(intake);
  if (missing) {
    intake.awaiting = missing;
    return INTAKE_PROMPTS[missing];
  }

  if (!isCompletePrintPlanIntake(intake.slots)) {
    return "Let me check those details once more before I submit them.";
  }

  const result = await toolExecutor(
    "send_support_escalation",
    JSON.stringify(intake.slots),
    { callSid, callStartedAtMs: session.startedAtMs },
  );

  if (result.toolPayload.ok === true) {
    intake.active = false;
    return SCRIPTS.escalationSent;
  }

  return (
    result.spokenHint ??
    "I couldn't submit that just yet. Your details are still here, and our support team can help on the next business day."
  );
}

function getSession(callSid: string): SessionMemory {
  let s = sessions.get(callSid);
  if (!s) {
    s = { history: [], startedAtMs: Date.now() };
    sessions.set(callSid, s);
  }
  return s;
}

export function clearSession(callSid: string): void {
  sessions.delete(callSid);
}

/** Test helper — backdate session start for transfer gating. */
export function setSessionStartedAt(callSid: string, startedAtMs: number): void {
  const s = getSession(callSid);
  s.startedAtMs = startedAtMs;
}

export function greetingSpeech(): string {
  return GREETING_SPEECH;
}

function finalizeSpeech(raw: string): string {
  return clampSpokenLength(truncateToSentences(raw, 3), 55);
}

function remember(session: SessionMemory, user: string, assistant: string): void {
  session.history.push({ role: "user", content: user });
  session.history.push({ role: "assistant", content: assistant });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
}

/** Deterministic policy / product answers when OpenAI is unavailable or for crisp voice UX. */
function matchPolicyFastPath(utterance: string): string | null {
  if (REFUND_RE.test(utterance)) {
    return `I understand. ${SCRIPTS.refundFinal}`;
  }
  if (ADDRESS_CHANGE_RE.test(utterance)) {
    return `Not a problem. ${SCRIPTS.addressChange}`;
  }
  // Upset + delay: when OpenAI is available, fall through so send_support_escalation can run.
  if (UPSET_RE.test(utterance) && DELAY_RE.test(utterance)) {
    if (!getConfig().MAILCALL_OPENAI_API_KEY) {
      return SCRIPTS.escalation;
    }
    return null;
  }
  if (DELAY_RE.test(utterance)) {
    return SCRIPTS.delayedDelivery;
  }
  if (PRICING_RE.test(utterance) || findPlanByUtterance(utterance)) {
    const plan = findPlanByUtterance(utterance);
    return buildProductCatalogSpeech(plan?.sku);
  }
  return null;
}

async function maybeLlmSpeechWithTools(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  ctx: { callSid: string; callStartedAtMs: number },
): Promise<{ speech: string | null; transferToNumber?: string }> {
  const cfg = getConfig();
  if (!cfg.MAILCALL_OPENAI_API_KEY) return { speech: null };

  const client = new OpenAI({ apiKey: cfg.MAILCALL_OPENAI_API_KEY });
  const working: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let transferToNumber: string | undefined;

  for (let round = 0; round < 3; round++) {
    const completion = await client.chat.completions.create({
      model: cfg.MAILCALL_OPENAI_MODEL,
      temperature: 0.35,
      max_tokens: 180,
      messages: working,
      tools: MAILCALL_TOOL_DEFINITIONS,
      tool_choice: "auto",
    });

    const choice = completion.choices[0]?.message;
    if (!choice) break;

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = choice.content?.trim();
      return { speech: text ? finalizeSpeech(text) : null, transferToNumber };
    }

    working.push({
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const result = await executeMailCallTool(call.function.name, call.function.arguments, ctx);
      if (result.transferToNumber) transferToNumber = result.transferToNumber;
      working.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          ...result.toolPayload,
          spoken_hint: result.spokenHint,
        }),
      });
    }
  }

  return { speech: null, transferToNumber };
}

export async function processConversationTurn(
  input: ConversationTurnInput,
  wp: WordPressApiClient = getWordPressApiClient(),
  toolExecutor: MailCallToolExecutor = executeMailCallTool,
): Promise<CallTurnResult> {
  const started = Date.now();
  const utterance = input.utterance.trim();
  const session = getSession(input.callSid);

  if (!utterance) {
    return {
      speech: "Sorry, I didn't catch that. Could you say that again?",
      degraded: false,
      articlesUsed: 0,
      latencyMs: Date.now() - started,
    };
  }

  const intakeSpeech = await processPrintIntake(
    session,
    input.callSid,
    utterance,
    toolExecutor,
  );
  if (intakeSpeech) {
    const speech = finalizeSpeech(intakeSpeech);
    remember(session, utterance, speech);
    return {
      speech,
      degraded: false,
      articlesUsed: 0,
      latencyMs: Date.now() - started,
    };
  }

  if (OFF_TOPIC_RE.test(utterance)) {
    const speech = finalizeSpeech(offTopicRedirectSpeech());
    remember(session, utterance, speech);
    return {
      speech,
      degraded: false,
      articlesUsed: 0,
      usedBrandProfile: true,
      latencyMs: Date.now() - started,
    };
  }

  const policySpeech = matchPolicyFastPath(utterance);
  if (policySpeech) {
    const speech = finalizeSpeech(policySpeech);
    remember(session, utterance, speech);
    return {
      speech,
      degraded: false,
      articlesUsed: 0,
      latencyMs: Date.now() - started,
    };
  }

  // Caller country code and network geolocation are intentionally ignored here.
  // Corporate location is immutable and comes only from the local brand profile.
  if (CORPORATE_HEADQUARTERS_RE.test(utterance)) {
    const speech = finalizeSpeech(
      `The physical headquarters, administrative offices, and editorial staff of MailCall Newspaper are strictly located at ${brandProfile.address}.`,
    );
    remember(session, utterance, speech);
    return {
      speech,
      degraded: false,
      articlesUsed: 0,
      usedBrandProfile: true,
      latencyMs: Date.now() - started,
    };
  }

  // Corporate identity queries bypass article search and use the structural page map.
  const corporateKnowledge = CORPORATE_IDENTITY_RE.test(utterance)
    ? wp.retrieveCorporatePageContext(utterance)
    : null;
  const knowledge = corporateKnowledge ?? (await wp.retrieveForLiveTurn(utterance));
  const history = input.history ?? session.history.slice(-8);
  const messages = buildTurnMessages({
    userUtterance: utterance,
    articles: knowledge.articles,
    categories: knowledge.categories,
    degraded: knowledge.degraded,
    usedBrandProfile: knowledge.usedBrandProfile,
    brandKnowledge: knowledge.brandKnowledge,
    history,
  });

  logger.info("mailcall_turn_rag", {
    callSid: input.callSid,
    articlesUsed: knowledge.articles.length,
    degraded: knowledge.degraded,
    usedBrandProfile: Boolean(knowledge.usedBrandProfile),
    ragLatencyMs: knowledge.latencyMs,
  });

  let speech: string;
  let transferToNumber: string | undefined;

  try {
    const llm = await maybeLlmSpeechWithTools(messages, {
      callSid: input.callSid,
      callStartedAtMs: session.startedAtMs,
    });
    transferToNumber = llm.transferToNumber;

    if (llm.speech) {
      speech = llm.speech;
    } else if (knowledge.usedBrandProfile && knowledge.brandSpeech) {
      speech = finalizeSpeech(knowledge.brandSpeech);
    } else {
      speech = finalizeSpeech(
        buildRetrievalOnlySpeech(knowledge.articles, {
          degraded: knowledge.degraded,
          brandSpeech: knowledge.brandSpeech,
        }) ?? brandOfflineFallbackSpeech(utterance),
      );
    }
  } catch (err) {
    logger.error("mailcall_llm_failed", {
      callSid: input.callSid,
      error: err instanceof Error ? err.message : String(err),
    });
    speech = finalizeSpeech(
      (knowledge.usedBrandProfile && knowledge.brandSpeech) ||
        buildRetrievalOnlySpeech(knowledge.articles, {}) ||
        brandOfflineFallbackSpeech(utterance),
    );
  }

  remember(session, utterance, speech);

  return {
    speech,
    degraded: Boolean(knowledge.degraded),
    articlesUsed: knowledge.articles.length,
    usedBrandProfile: knowledge.usedBrandProfile,
    transferToNumber,
    latencyMs: Date.now() - started,
  };
}
