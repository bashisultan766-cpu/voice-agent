/**
 * Reusable objection patterns for bookstore voice commerce.
 * Returns coaching hints for the model and optional deterministic reply seeds.
 */

export type ObjectionType =
  | 'too_expensive'
  | 'need_cheaper'
  | 'unsure'
  | 'let_me_think'
  | 'call_later'
  | 'wants_recommendation'
  | 'comparing_products'
  | 'shipping_concern'
  | 'refund_concern'
  | 'payment_link_resend'
  | 'checkout_recovery';

export type ObjectionMatch = {
  type: ObjectionType;
  confidence: number;
  coachingHint: string;
  suggestedReplySeed?: string;
};

function norm(text: string): string {
  return text.toLowerCase().trim();
}

const PATTERNS: Array<{ type: ObjectionType; re: RegExp; hint: string; seed?: string }> = [
  {
    type: 'too_expensive',
    re: /\b(too expensive|too much|can't afford|costs? too much|pricey)\b/i,
    hint: 'Acknowledge budget; offer one in-stock alternative from search only, or confirm current title price from tools.',
    seed: 'I hear you on price. Would you like a similar title, or should I confirm the exact price for this one?',
  },
  {
    type: 'need_cheaper',
    re: /\b(need cheaper|something cheaper|less expensive|budget|affordable|lower cost)\b/i,
    hint: 'Search for lower-priced in-stock alternatives in same genre; cite tool prices only.',
    seed: 'I can look for a lower-priced option in stock. What genre should I search?',
  },
  {
    type: 'unsure',
    re: /\b(not sure|don't know|unsure|maybe|still deciding|can't decide)\b/i,
    hint: 'Ask one narrowing question (genre, author, gift recipient). Do not pressure checkout.',
    seed: 'No rush. What genre or author should I narrow down for you?',
  },
  {
    type: 'let_me_think',
    re: /\b(let me think|i'll think|need to think|give me a minute|sleep on it)\b/i,
    hint: 'Respect pause; offer to hold one title in mind or send checkout link when ready — no pressure.',
    seed: 'Take your time. I can keep this title ready, or send a checkout link when you are set.',
  },
  {
    type: 'call_later',
    re: /\b(call (you )?later|call back|i'll call|phone later|not now|maybe later)\b/i,
    hint: 'Recover checkout gracefully: offer email link, callback, or one alternative title.',
    seed: 'No problem. I can email a secure checkout link, or we can pick this up when you call back.',
  },
  {
    type: 'wants_recommendation',
    re: /\b(recommend|suggestion|what should i (read|get)|best seller|bestseller|popular|top book)\b/i,
    hint: 'Run product search; recommend max two titles from tool results with inventory noted.',
    seed: 'I can suggest a couple of options from our catalog. What genre or topic interests you?',
  },
  {
    type: 'comparing_products',
    re: /\b(compare|versus|vs\.?|which one|difference between|better between)\b/i,
    hint: 'Compare only facts from tool data: price, format, availability. No invented differences.',
    seed: 'I can compare the options we found—tell me which two titles you mean.',
  },
  {
    type: 'shipping_concern',
    re: /\b(shipping|delivery|how long|when will it arrive|ship to|postage)\b/i,
    hint: 'Use store shipping policy from config; if unknown, say you do not have verified timing.',
    seed: 'For delivery timing I rely on our store policy—want me to summarize what we have on file?',
  },
  {
    type: 'refund_concern',
    re: /\b(refund|return|exchange|money back|cancel order)\b/i,
    hint: 'Use return/refund policy from agent config; escalate if policy missing.',
    seed: 'I can explain our return policy for this store. Are you asking about a recent order or a new purchase?',
  },
  {
    type: 'payment_link_resend',
    re: /\b(resend|send again|didn't get|did not receive|email again|link again)\b/i,
    hint: 'Confirm email on file, then use send payment email tool once; do not claim sent without tool success.',
    seed: 'I can resend the checkout link—what email should I use?',
  },
  {
    type: 'checkout_recovery',
    re: /\b(start over|go back|wrong book|wrong item|change (the )?book|different book)\b/i,
    hint: 'Reset to discovery; keep cart memory but confirm new title before checkout.',
    seed: 'Sure, we can switch titles. What should I look up instead?',
  },
];

export function classifyConversationalObjection(text: string): ObjectionMatch | null {
  const t = norm(text);
  if (!t) return null;
  for (const p of PATTERNS) {
    if (p.re.test(t)) {
      return {
        type: p.type,
        confidence: 0.85,
        coachingHint: p.hint,
        suggestedReplySeed: p.seed,
      };
    }
  }
  return null;
}

export function objectionReplyFromMatch(
  match: ObjectionMatch,
  languageCode = 'en',
): string | null {
  if (!match.suggestedReplySeed) return null;
  const lang = languageCode.toLowerCase().slice(0, 2);
  if (lang === 'it' && match.type === 'too_expensive') {
    return 'Capisco il budget. Preferisci un titolo simile o confermo il prezzo esatto di questo?';
  }
  if (lang === 'ru' && match.type === 'too_expensive') {
    return 'Понимаю. Подобрать похожую книгу или уточнить точную цену на эту?';
  }
  return match.suggestedReplySeed;
}
