import {
  buildEmailConfirmationPrompt,
  formatEmailForVoiceConfirmation,
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
  validateVoiceEmail,
} from '../../calls/runtime/voice-email-capture.util';
import type { CheckoutProductOption, VoiceCheckoutSession, VoiceCheckoutStage } from './voice-checkout-session.types';

const ORDINALS: Record<string, number> = {
  first: 0,
  '1st': 0,
  second: 1,
  '2nd': 1,
  third: 2,
  '3rd': 2,
};

export function isResendPaymentEmailRequest(utterance: string): boolean {
  return /\b(resend|send again|didn't get|did not receive|never got|no email)\b/i.test(utterance);
}

export function isCheckoutInterrupt(utterance: string): boolean {
  return /\b(cancel|never mind|nevermind|stop|different book|another book|start over)\b/i.test(utterance);
}

export function isCheckoutAffirmative(utterance: string): boolean {
  const lower = utterance.trim().toLowerCase();
  if (isEmailConfirmationNegative(lower)) return false;
  return /\b(yes|yeah|yep|correct|that's right|that is right|send it|go ahead|please do|checkout)\b/i.test(
    lower,
  );
}

export function resolveProductSelection(
  utterance: string,
  candidates: CheckoutProductOption[],
): CheckoutProductOption | null {
  if (candidates.length === 0) return null;
  const lower = utterance.toLowerCase();

  for (const [word, idx] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower) && candidates[idx]) {
      return candidates[idx]!;
    }
  }

  const numMatch = lower.match(/\b(?:number|option|#)\s*(\d)\b/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < candidates.length) return candidates[idx]!;
  }

  let best: CheckoutProductOption | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const titleWords = c.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const hits = titleWords.filter((w) => lower.includes(w)).length;
    const score = hits / Math.max(titleWords.length, 1);
    if (score > bestScore && score >= 0.4) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export function mapSearchProducts(
  products: Array<{ id?: string; variantId?: string; title: string; price?: string; inStock?: boolean }>,
): CheckoutProductOption[] {
  return products.slice(0, 5).map((p) => ({
    id: p.id ?? p.title,
    variantId: p.variantId ?? p.id ?? p.title,
    title: p.title,
    price: p.price,
    inStock: p.inStock !== false,
  }));
}

export function applySearchResultsToSession(
  session: VoiceCheckoutSession,
  products: CheckoutProductOption[],
): VoiceCheckoutSession {
  if (products.length === 0) return session;

  const next = { ...session, candidates: products };

  if (products.length === 1) {
    const only = products[0]!;
    next.selected = only;
    next.stage = only.inStock ? 'awaiting_email' : 'out_of_stock';
    return next;
  }

  next.stage = 'awaiting_product_selection';
  next.selected = undefined;
  return next;
}

export function applyProductSelectionToSession(
  session: VoiceCheckoutSession,
  utterance: string,
): VoiceCheckoutSession {
  if (session.stage !== 'awaiting_product_selection') return session;
  const picked = resolveProductSelection(utterance, session.candidates);
  if (!picked) return session;

  return {
    ...session,
    selected: picked,
    stage: picked.inStock ? 'awaiting_email' : 'out_of_stock',
  };
}

export function applyEmailCaptureToSession(
  session: VoiceCheckoutSession,
  normalized: string,
): VoiceCheckoutSession {
  return {
    ...session,
    pendingEmail: normalized,
    emailConfirmationState: 'pending',
    stage: 'email_confirmation',
  };
}

export function applyEmailConfirmationToSession(
  session: VoiceCheckoutSession,
  utterance: string,
): VoiceCheckoutSession {
  if (session.stage !== 'email_confirmation' || !session.pendingEmail) return session;

  if (isEmailConfirmationAffirmative(utterance)) {
    return {
      ...session,
      confirmedEmail: session.pendingEmail,
      emailConfirmationState: 'confirmed',
      stage: 'product_selected',
    };
  }

  if (isEmailConfirmationNegative(utterance)) {
    return {
      ...session,
      pendingEmail: undefined,
      emailConfirmationState: 'rejected',
      stage: 'awaiting_email',
    };
  }

  return session;
}

export function canCreatePaymentLink(session: VoiceCheckoutSession): boolean {
  if (!session.selected?.variantId || !session.selected.inStock) return false;
  const email = session.confirmedEmail?.trim();
  if (!email) return false;
  const validation = validateVoiceEmail(email);
  return validation.valid;
}

export function emailConfirmationPrompt(email: string): string {
  return buildEmailConfirmationPrompt(email);
}

export function emailSpellbackPrompt(email: string): string {
  return `Just to confirm, I have your email as ${formatEmailForVoiceConfirmation(email)}. Is that correct?`;
}

export function checkoutStageFiller(stage: VoiceCheckoutStage, slowTool?: boolean): string {
  if (slowTool) return "I'm still working on that — one moment.";
  switch (stage) {
    case 'awaiting_product_selection':
      return 'Let me pull up those options for you…';
    case 'awaiting_email':
    case 'email_confirmation':
      return 'Got it — let me verify that email.';
    case 'payment_pending':
      return 'One moment while I prepare your secure checkout link.';
    default:
      return 'One moment…';
  }
}

export function synthesizeCheckoutReply(session: VoiceCheckoutSession): string | null {
  switch (session.stage) {
    case 'awaiting_product_selection': {
      const titles = session.candidates
        .slice(0, 3)
        .map((c, i) => `${i + 1}. ${c.title}`)
        .join('; ');
      return `I found a few matches: ${titles}. Which one would you like?`;
    }
    case 'out_of_stock':
      return session.selected
        ? `"${session.selected.title}" is currently out of stock. Would you like me to find a similar title?`
        : "That title is out of stock. Would you like another option?";
    case 'awaiting_email':
      return "Perfect. I'll help you place the order. Please tell me your email address so I can send your payment link.";
    case 'email_confirmation':
      return session.pendingEmail ? emailConfirmationPrompt(session.pendingEmail) : null;
    case 'payment_pending':
      if (session.paymentLinkSent) {
        return "I've sent a secure checkout link to your email. You should receive it shortly.";
      }
      if (session.lastError) {
        return "I had trouble creating the checkout link. Let me try that again — what's the best email to use?";
      }
      return null;
    case 'payment_completed':
      return 'Great news — your payment went through. Thank you for your order!';
    default:
      return null;
  }
}
