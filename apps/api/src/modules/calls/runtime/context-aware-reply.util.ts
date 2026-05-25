import type { OrderState } from './order-state-machine.util';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { VoiceTurnToolTrace } from './voice-turn-tool-trace.util';
import { resolveToneLead, type ConversationTone } from './conversation-tone.util';
import {
  classifyConversationalObjection,
  objectionReplyFromMatch,
} from './objection-patterns.util';

type ConversationTurn = { role: 'user' | 'assistant'; content: string };

type KnownProduct = {
  title?: string;
  price?: string;
};

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function looksLikeQuestion(text: string, intent: UserUtteranceIntent): boolean {
  const t = normalizeText(text);
  if (intent === 'product_question' || intent === 'payment_question') return true;
  if (t.includes('?')) return true;
  return /\b(what|which|how|when|where|why|price|cost|available|payment)\b/i.test(t);
}

function parseKnownProductFromAssistantText(text: string): KnownProduct | null {
  const m = text.match(/i found\s+(.+?)\.\s+it'?s available for\s+(.+?)\./i);
  if (!m) return null;
  const title = m[1]?.trim();
  const price = m[2]?.trim();
  if (!title || !price) return null;
  return { title, price };
}

function getKnownProductFromToolResult(toolResult?: VoiceTurnToolTrace): KnownProduct | null {
  const sp = toolResult?.searchProducts;
  if (!sp?.ok || !sp.found || !sp.title) return null;
  return { title: sp.title, price: sp.price ?? undefined };
}

function getKnownProductFromHistory(history: ConversationTurn[]): KnownProduct | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const t = history[i];
    if (t.role !== 'assistant') continue;
    const parsed = parseKnownProductFromAssistantText(t.content);
    if (parsed) return parsed;
  }
  return null;
}

function getCorrectionHint(lastUserMessage: string): string {
  const t = normalizeText(lastUserMessage);
  if (t.includes('paperback')) return 'paperback';
  if (t.includes('hardcover')) return 'hardcover';
  if (t.includes('isbn')) return 'ISBN';
  return 'right edition';
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Narrow, non-scripted assists that stay factual (price from known product).
 * Everything else is left to OpenAI for a human-like sales tone.
 */
export function buildContextAwareReply(args: {
  intent: UserUtteranceIntent;
  state: OrderState;
  previousState: OrderState;
  lastUserMessage: string;
  toolResult?: VoiceTurnToolTrace;
  conversationHistory: ConversationTurn[];
  conversationTone: ConversationTone;
  lastToneLeadUsed: string | null;
  allowPaymentSuggestion: boolean;
  followUpOfferedProductKey?: string | null;
}): {
  text: string;
  source: 'template' | 'openai';
  templateKey?: string;
  questionAnsweredFirst: boolean;
  interruptionHandled: boolean;
  toneLeadUsed: string | null;
  paymentSuggestionUsed: boolean;
  followUpTriggered?: boolean;
  followUpOfferedProductKey?: string | null;
} | null {
  const knownFromTool = getKnownProductFromToolResult(args.toolResult);
  const knownFromHistory = getKnownProductFromHistory(args.conversationHistory);
  const known = knownFromTool ?? knownFromHistory;
  const userQuestion = looksLikeQuestion(args.lastUserMessage, args.intent);

  if (userQuestion) {
    const t = normalizeText(args.lastUserMessage);
    const askingPrice = /\b(price|cost|how much)\b/i.test(t);
    if (askingPrice && known?.price) {
      const { lead, toneLeadUsed } = resolveToneLead({
        slot: 'price',
        conversationTone: args.conversationTone,
        lastToneLeadUsed: args.lastToneLeadUsed,
      });
      const core = `it's ${known.price}.`;
      const text = lead ? `${lead} ${core}` : capitalizeFirst(core);
      return {
        text,
        source: 'openai',
        questionAnsweredFirst: true,
        interruptionHandled: Boolean(
          args.previousState === 'PRODUCT_DISCOVERY' && args.intent !== 'product_search',
        ),
        toneLeadUsed,
        paymentSuggestionUsed: false,
        followUpTriggered: false,
      };
    }
    if (askingPrice && !known?.price) {
      return {
        text: 'Which title or ISBN should I price for you?',
        source: 'openai',
        questionAnsweredFirst: true,
        interruptionHandled: false,
        toneLeadUsed: null,
        paymentSuggestionUsed: false,
        followUpTriggered: false,
      };
    }
  }

  const objection = classifyConversationalObjection(args.lastUserMessage);
  if (objection?.suggestedReplySeed) {
    const seed =
      objectionReplyFromMatch(objection, 'en') ?? objection.suggestedReplySeed;
    const { lead, toneLeadUsed } = resolveToneLead({
      slot: 'objection',
      conversationTone: args.conversationTone,
      lastToneLeadUsed: args.lastToneLeadUsed,
    });
    const text = lead ? `${lead} ${seed}` : seed;
    return {
      text,
      source: 'openai',
      templateKey: `objection_${objection.type}`,
      questionAnsweredFirst: true,
      interruptionHandled: true,
      toneLeadUsed,
      paymentSuggestionUsed: false,
      followUpTriggered: false,
    };
  }

  if (args.intent === 'correction') {
    const hint = getCorrectionHint(args.lastUserMessage);
    const { lead, toneLeadUsed } = resolveToneLead({
      slot: 'correction',
      conversationTone: args.conversationTone,
      lastToneLeadUsed: args.lastToneLeadUsed,
    });
    const tail = `I'll recheck the listing for the ${hint}.`;
    const text = lead ? `${lead} ${tail}` : capitalizeFirst(tail);
    return {
      text,
      source: 'openai',
      questionAnsweredFirst: false,
      interruptionHandled: true,
      toneLeadUsed,
      paymentSuggestionUsed: false,
      followUpTriggered: false,
    };
  }

  return null;
}
