/**
 * Emotion-aware voice output — applied ONLY to voice_text after full intent processing.
 */

import type {
  ActionExecutionRecord,
  IntentAnalysisResult,
  IntentEmotion,
} from './types/intent-analysis.types';

const TECHNICAL_RE =
  /\b(api|graphql|json|metadata|webhook|redis|shopify admin|endpoint|status code|latency)\b/gi;
const MULTI_SPACE = /\s{2,}/g;

export type VoiceSummarizeInput = {
  text_response: string;
  intent: IntentAnalysisResult;
  actions_executed: ActionExecutionRecord[];
  human_queue?: boolean;
};

const EMOTION_LEAD: Record<IntentEmotion, string | null> = {
  angry: "I hear you, and I'm sorry this has been frustrating.",
  frustrated: 'I understand — let me help fix this.',
  neutral: null,
  happy: 'Happy to help!',
};

const HUMAN_QUEUE_VOICE =
  "I'm connecting you with a specialist who can take care of this right away.";

export function stripTechnicalLanguage(text: string): string {
  return text.replace(TECHNICAL_RE, '').replace(MULTI_SPACE, ' ').trim();
}

export function truncateToVoiceSentences(text: string, maxSentences = 2, maxChars = 220): string {
  const cleaned = stripTechnicalLanguage(text.replace(/\s+/g, ' ').trim());
  if (!cleaned) return '';

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  let out = sentences.slice(0, maxSentences).join(' ').trim();
  if (out.length > maxChars) {
    const words = out.split(/\s+/);
    let buf = '';
    for (const w of words) {
      const next = buf ? `${buf} ${w}` : w;
      if (next.length > maxChars - 1) break;
      buf = next;
    }
    out = buf.endsWith('.') || buf.endsWith('!') || buf.endsWith('?') ? buf : `${buf}.`;
  }
  return out.replace(MULTI_SPACE, ' ').trim();
}

function weaveEmotionalTone(text: string, emotion: IntentEmotion): string {
  if (emotion === 'neutral' || emotion === 'happy') {
    if (emotion === 'happy' && !/^happy/i.test(text)) {
      return truncateToVoiceSentences(`Great — ${text.charAt(0).toLowerCase()}${text.slice(1)}`, 2, 220);
    }
    return text;
  }
  const lead = EMOTION_LEAD[emotion];
  if (!lead) return text;
  return truncateToVoiceSentences(`${lead} ${text}`, 2, 220);
}

export function summarizeForVoice(input: VoiceSummarizeInput): string {
  if (input.human_queue) {
    return weaveEmotionalTone(HUMAN_QUEUE_VOICE, input.intent.emotion);
  }

  const maxSentences = Number(process.env.VOICE_TTS_MAX_SENTENCES) || 2;
  const maxChars = Number(process.env.VOICE_TTS_MAX_CHARS) || 220;

  const actionLines = input.actions_executed
    .filter((a) => a.success && a.summary.trim())
    .map((a) => stripTechnicalLanguage(a.summary.trim()));

  let core = '';
  if (actionLines.length >= 2) {
    core = truncateToVoiceSentences(actionLines.slice(0, 2).join(' '), maxSentences, maxChars);
  } else if (actionLines.length === 1 && input.intent.multi_intent) {
    const pending = input.intent.secondary_intents[0];
    const second =
      pending && pending.length > 0
        ? `I also noted your ${pending.replace(/_/g, ' ')} and will handle that next.`
        : 'I will take care of your other request next.';
    core = truncateToVoiceSentences(`${actionLines[0]} ${second}`, maxSentences, maxChars);
  } else if (actionLines.length === 1) {
    core = truncateToVoiceSentences(actionLines[0], maxSentences, maxChars);
  } else {
    core = truncateToVoiceSentences(input.text_response, maxSentences, maxChars);
  }

  if (input.intent.refund_risk && !/refund/i.test(core)) {
    core = truncateToVoiceSentences(
      `${core} I will prioritize your refund request.`,
      maxSentences,
      maxChars,
    );
  }

  const preserveMultiIntent = input.intent.multi_intent && actionLines.length >= 1;
  return preserveMultiIntent ? core : weaveEmotionalTone(core, input.intent.emotion);
}

export function normalizePreparedVoiceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Minimal intent stub for legacy paths that only have reply text. */
export function stubIntentForVoiceSummary(
  customerRequest: string,
  primary = 'general',
): IntentAnalysisResult {
  return {
    intent: primary,
    primary_intent: primary,
    secondary_intents: [],
    multi_intent: false,
    entities: {
      order_id: null,
      order_ids: [],
      products: [],
      quantity: null,
      customer_request: customerRequest,
    },
    actions: ['general'],
    risk_level: 'low',
    emotion: 'neutral',
    urgency: 'low',
    refund_risk: false,
    source: 'rules_fallback',
  };
}
