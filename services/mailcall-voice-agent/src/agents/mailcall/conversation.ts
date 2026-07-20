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
import { buildCatalog, catalogKnowledgeBlock } from "./catalog.js";
import {
  buildRetrievalOnlySpeech,
  buildTurnMessages,
} from "./prompts.js";
import {
  executeMailCallTool,
  clearCheckoutSendLock,
  getCheckoutSendLock,
  isEmailConfirmation,
  MAILCALL_TOOL_DEFINITIONS,
  type CheckoutLinkIntake,
} from "./tools.js";
import {
  applyEmailTokenCorrection,
  looksLikeEmail,
  normalizeSpokenEmail,
  speakEmailForConfirm,
} from "./emailNormalize.js";
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
  checkoutIntake?: CheckoutIntakeState;
  hasCheckoutLinkBeenSent?: boolean;
  checkoutLinkEmail?: string;
  awaitingResendConfirm?: boolean;
}

type IntakeSlot = "contact_email" | "email_confirm";

interface CheckoutIntakeState {
  active: boolean;
  slots: Partial<CheckoutLinkIntake>;
  awaiting?: IntakeSlot;
}

type MailCallToolExecutor = typeof executeMailCallTool;

const sessions = new Map<string, SessionMemory>();

const OFF_TOPIC_RE =
  /\b(python|javascript|code|program(ming)?|cook(ing)?|recipe|bitcoin|crypto|weather forecast|homework|math problem)\b/i;

const PRICING_RE =
  /\b(price|pricing|plan|plans|cost|how much|subscription|what('s| is) included|sections?|packages?|categories|urban|spanish|global|bundle)\b/i;

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

const END_CALL_INTENT_RE =
  /\b(goodbye|good bye|bye bye|bye|see you|talk to you later|that'?s all|that is all|nothing else|no thanks|no thank you|i(?:'m| am) good|no more (help|questions|information)|i(?:'m| am) done|i don'?t need anything else|end the call|hang up|you can hang up)\b/i;

const PURCHASE_INTENT_RE =
  /\b(buy|purchase|subscribe|sign me up|sign up|set up|start|checkout|order|send (me )?(a )?(link|newspaper)|get (me )?(a )?link)\b|\b(i want|i'd like|i would like|ready|please)\b.*\b(subscribe|subscription|buy|purchase|plan|edition|newspaper|link|order)\b/i;

const RESEND_INTENT_RE =
  /\b(resend|send (it |the link )?again|send another|didn't (get|receive)|did not (get|receive)|haven't (got|received)|check(ing)? (my )?spam)\b/i;

const INMATE_PII_PROBE_RE =
  /\b(inmate (name|number|id)|booking number|facility (name|address)|prison (name|address)|correctional (facility|center) address)\b/i;

const INTAKE_SLOT_ORDER: IntakeSlot[] = ["contact_email", "email_confirm"];

const INTAKE_PROMPTS: Record<IntakeSlot, string> = {
  contact_email: SCRIPTS.emailAsk,
  email_confirm: "Is that correct?",
};

function emailConfirmPrompt(email: string): string {
  // No period before the question — keeps domain spell-back intact through sentence clampers
  return `I have your email as ${speakEmailForConfirm(email)} — is that correct?`;
}

function cleanSpokenValue(raw: string): string {
  return raw
    .trim()
    .replace(
      /^(?:it(?:'s| is)|this is|my (?:email|address) is)\s+/i,
      "",
    )
    .trim();
}

function captureIntakeSlot(
  intake: CheckoutIntakeState,
  slot: IntakeSlot,
  utterance: string,
): { accepted: boolean; retrySpeech?: string } {
  const value = cleanSpokenValue(utterance);
  switch (slot) {
    case "contact_email": {
      const email = normalizeSpokenEmail(value);
      if (!looksLikeEmail(email)) {
        return {
          accepted: false,
          retrySpeech: SCRIPTS.emailRetry,
        };
      }
      intake.slots.contact_email = email;
      intake.slots.email_confirmed = false;
      // Immediately move to phonetic confirm — do not re-ask with robotic parsing tips.
      intake.awaiting = "email_confirm";
      return {
        accepted: false,
        retrySpeech: emailConfirmPrompt(email),
      };
    }
    case "email_confirm": {
      const confirmed = isEmailConfirmation(value);
      if (confirmed === true) {
        intake.slots.email_confirmed = true;
        break;
      }
      if (confirmed === false) {
        intake.slots.email_confirmed = false;
        intake.awaiting = "email_confirm";
        return {
          accepted: false,
          retrySpeech: SCRIPTS.emailCorrectionAsk,
        };
      }

      if (intake.slots.contact_email) {
        const patched = applyEmailTokenCorrection(intake.slots.contact_email, value);
        if (patched) {
          intake.slots.contact_email = patched;
          intake.slots.email_confirmed = false;
          intake.awaiting = "email_confirm";
          return {
            accepted: false,
            retrySpeech: emailConfirmPrompt(patched),
          };
        }
      }

      const email = normalizeSpokenEmail(value);
      if (looksLikeEmail(email)) {
        intake.slots.contact_email = email;
        intake.slots.email_confirmed = false;
        intake.awaiting = "email_confirm";
        return {
          accepted: false,
          retrySpeech: emailConfirmPrompt(email),
        };
      }
      return {
        accepted: false,
        retrySpeech: intake.slots.contact_email
          ? emailConfirmPrompt(intake.slots.contact_email)
          : SCRIPTS.emailRetry,
      };
    }
  }
  intake.awaiting = undefined;
  return { accepted: true };
}

function nextMissingIntakeSlot(intake: CheckoutIntakeState): IntakeSlot | undefined {
  for (const slot of INTAKE_SLOT_ORDER) {
    if (slot === "email_confirm") {
      if (!intake.slots.email_confirmed) return "email_confirm";
      continue;
    }
    const value = intake.slots[slot];
    if (value === undefined || value === "") return slot;
  }
  return undefined;
}

function isCompleteCheckoutIntake(
  slots: Partial<CheckoutLinkIntake>,
): slots is CheckoutLinkIntake {
  return Boolean(slots.contact_email && slots.email_confirmed === true);
}

async function processCheckoutIntake(
  session: SessionMemory,
  callSid: string,
  utterance: string,
  toolExecutor: MailCallToolExecutor,
): Promise<string | null> {
  // Already sent — offer resend only after explicit confirmation
  if (session.hasCheckoutLinkBeenSent || getCheckoutSendLock(callSid)) {
    session.hasCheckoutLinkBeenSent = true;

    if (session.awaitingResendConfirm) {
      const confirmed = isEmailConfirmation(utterance);
      if (confirmed === true || RESEND_INTENT_RE.test(utterance)) {
        session.awaitingResendConfirm = false;
        const email =
          session.checkoutLinkEmail ||
          getCheckoutSendLock(callSid)?.email ||
          session.checkoutIntake?.slots.contact_email;
        if (!email) {
          session.checkoutIntake = { active: true, slots: {} };
          session.checkoutIntake.awaiting = "contact_email";
          return INTAKE_PROMPTS.contact_email;
        }
        const result = await toolExecutor(
          "send_checkout_link",
          JSON.stringify({ contact_email: email, force_resend: true }),
          { callSid, callStartedAtMs: session.startedAtMs, forceResend: true },
        );
        if (result.toolPayload.ok === true) {
          return SCRIPTS.checkoutResent;
        }
        return result.spokenHint ?? SCRIPTS.voicemail;
      }
      if (confirmed === false) {
        session.awaitingResendConfirm = false;
        return "No problem. Please check the email I already sent. How else can I help?";
      }
      session.awaitingResendConfirm = true;
      return SCRIPTS.checkoutAlreadySent;
    }

    if (
      RESEND_INTENT_RE.test(utterance) ||
      PURCHASE_INTENT_RE.test(utterance) ||
      /\b(link|email|send)\b/i.test(utterance)
    ) {
      session.awaitingResendConfirm = true;
      return SCRIPTS.checkoutAlreadySent;
    }
  }

  const beginsNow = !session.checkoutIntake?.active && PURCHASE_INTENT_RE.test(utterance);
  if (beginsNow) {
    session.checkoutIntake = { active: true, slots: {} };
  }

  const intake = session.checkoutIntake;
  if (!intake?.active) return null;

  if (INMATE_PII_PROBE_RE.test(utterance) && !intake.awaiting) {
    return SCRIPTS.privacyBoundary;
  }

  if (!beginsNow && intake.awaiting) {
    const captured = captureIntakeSlot(intake, intake.awaiting, utterance);
    if (!captured.accepted) {
      return captured.retrySpeech ?? INTAKE_PROMPTS[intake.awaiting];
    }
  }

  const missing = nextMissingIntakeSlot(intake);
  if (missing) {
    intake.awaiting = missing;
    if (missing === "email_confirm" && intake.slots.contact_email) {
      return emailConfirmPrompt(intake.slots.contact_email);
    }
    return INTAKE_PROMPTS[missing];
  }

  if (!isCompleteCheckoutIntake(intake.slots)) {
    return "Let me check that email once more before I send the link.";
  }

  const result = await toolExecutor(
    "send_checkout_link",
    JSON.stringify({
      contact_email: intake.slots.contact_email,
    }),
    { callSid, callStartedAtMs: session.startedAtMs },
  );

  if (result.toolPayload.ok === true) {
    intake.active = false;
    session.hasCheckoutLinkBeenSent = true;
    session.checkoutLinkEmail = intake.slots.contact_email;
    return SCRIPTS.checkoutLinkSent;
  }

  if (result.toolPayload.reason === "already_sent") {
    session.hasCheckoutLinkBeenSent = true;
    session.awaitingResendConfirm = true;
    return SCRIPTS.checkoutAlreadySent;
  }

  return (
    result.spokenHint ??
    "I couldn't send that link just yet. You're welcome to leave a message at support at mailcallnewspaper dot com."
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
  clearCheckoutSendLock(callSid);
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
  if (INMATE_PII_PROBE_RE.test(utterance)) {
    return SCRIPTS.privacyBoundary;
  }
  if (REFUND_RE.test(utterance)) {
    return `I understand. ${SCRIPTS.refundFinal}`;
  }
  if (ADDRESS_CHANGE_RE.test(utterance)) {
    return `Not a problem. ${SCRIPTS.addressChange}`;
  }
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

  if (END_CALL_INTENT_RE.test(utterance)) {
    const speech = finalizeSpeech(SCRIPTS.goodbye);
    remember(session, utterance, speech);
    return {
      speech,
      degraded: false,
      articlesUsed: 0,
      endCall: true,
      latencyMs: Date.now() - started,
    };
  }

  const intakeSpeech = await processCheckoutIntake(
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
  const catalog = buildCatalog({
    wpCategories: knowledge.categories,
    cmsPricingText: knowledge.articles
      .map((a) => `${a.title} ${a.content || a.excerpt || ""}`)
      .join("\n"),
  });
  const history = input.history ?? session.history.slice(-8);
  const messages = buildTurnMessages({
    userUtterance: utterance,
    articles: knowledge.articles,
    categories: knowledge.categories,
    degraded: knowledge.degraded,
    usedBrandProfile: knowledge.usedBrandProfile,
    brandKnowledge: knowledge.brandKnowledge,
    catalogBlock: catalogKnowledgeBlock(catalog),
    history,
  });

  logger.info("mailcall_turn_rag", {
    callSid: input.callSid,
    articlesUsed: knowledge.articles.length,
    degraded: knowledge.degraded,
    usedBrandProfile: Boolean(knowledge.usedBrandProfile),
    catalogSource: catalog.sourceLabel,
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
