import type { OrderState } from './order-state-machine.util';
import {
  resolveToneLead,
  responseIncludesPaymentSuggestion,
  type ConversationTone,
} from './conversation-tone.util';
import {
  buildEmailCollectionPrompt,
  buildEmailConfirmationPrompt,
} from './voice-email-capture.util';
import { normalizeProductFollowUpKey } from './product-follow-up.util';

export type ProfessionalProduct = { title: string; price: string | null };

const PAYMENT_SUGGESTION_PHRASES = [
  'Want me to email you the checkout link?',
  'Would you like me to send the payment link by email?',
  'If you want, I can send the checkout link to your email.',
];

function pickVariant(seed: string, options: readonly string[]): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return options[h % options.length];
}

export type ProfessionalResponseToneInput = {
  conversationTone: ConversationTone;
  lastToneLeadUsed: string | null;
};

/**
 * Deterministic lines only for payment confirmation, invalid-email safety, catalog failures,
 * and exact product facts (title/price) from tools. Everything else is spoken by OpenAI.
 */
export function buildProfessionalResponse(args: {
  state: OrderState;
  product?: ProfessionalProduct | null;
  email?: string | null;
  found: boolean;
  /** Append soft payment offer only when buy/order intent — not during browsing. */
  includePaymentSuggestion?: boolean;
  tone?: ProfessionalResponseToneInput;
  /** Once per product: soft "Would you like…" when browsing (no hard payment pitch). */
  followUpOfferedProductKey?: string | null;
}): {
  text: string;
  templateKey: string;
  toneLeadUsed?: string | null;
  paymentSuggestionUsed?: boolean;
  followUpTriggered?: boolean;
  followUpOfferedProductKey?: string | null;
} {
  const { state, product, email, found } = args;
  const trimmedEmail = email?.trim() ?? '';
  const tone = args.tone;

  if (state === 'DONE') {
    return {
      text: pickVariant('done_closing', [
        "You'll receive the payment link shortly. Let me know if you need anything else.",
        "The payment link is on its way. If you need anything else, I'm here.",
      ]),
      templateKey: 'done_closing',
      toneLeadUsed: null,
      paymentSuggestionUsed: false,
    };
  }

  if (trimmedEmail) {
    if (state === 'EMAIL_CONFIRMING') {
      return {
        text: buildEmailConfirmationPrompt(trimmedEmail),
        templateKey: 'email_confirm',
        toneLeadUsed: null,
        paymentSuggestionUsed: false,
      };
    }
    if (tone) {
      const { lead, toneLeadUsed } = resolveToneLead({
        slot: 'email_ack',
        conversationTone: tone.conversationTone,
        lastToneLeadUsed: tone.lastToneLeadUsed,
      });
      const text = lead
        ? `${lead} I'll send the payment link to ${trimmedEmail}.`
        : `I'll send the payment link to ${trimmedEmail}.`;
      return {
        text,
        templateKey: 'email_ack',
        toneLeadUsed,
        paymentSuggestionUsed: responseIncludesPaymentSuggestion(text),
      };
    }
    return {
      text: `Perfect, I'll send the payment link to ${trimmedEmail}.`,
      templateKey: 'email_ack',
      toneLeadUsed: 'Perfect,',
      paymentSuggestionUsed: false,
    };
  }

  if (state === 'EMAIL_COLLECTION' || state === 'EMAIL_COLLECTING') {
    if (tone) {
      const { lead, toneLeadUsed } = resolveToneLead({
        slot: 'email',
        conversationTone: tone.conversationTone,
        lastToneLeadUsed: tone.lastToneLeadUsed,
      });
      const collectionPrompt = buildEmailCollectionPrompt();
      const text = lead ? `${lead} ${collectionPrompt}` : collectionPrompt;
      return {
        text,
        templateKey: 'ask_email',
        toneLeadUsed,
        paymentSuggestionUsed: false,
      };
    }
    return {
      text: buildEmailCollectionPrompt(),
      templateKey: 'ask_email',
      toneLeadUsed: null,
      paymentSuggestionUsed: false,
    };
  }

  if (state === 'PRODUCT_DISCOVERY') {
    if (found && product?.title?.trim()) {
      const title = product.title.trim();
      const price = product.price?.trim() ?? '';
      const { lead, toneLeadUsed } = tone
        ? resolveToneLead({
            slot: 'product_found',
            conversationTone: tone.conversationTone,
            lastToneLeadUsed: tone.lastToneLeadUsed,
          })
        : { lead: 'Yes,', toneLeadUsed: 'Yes,' as string | null };

      const prefix = lead ? `${lead} ` : '';
      const core = price
        ? `${prefix}I found ${title}. It's available for ${price}.`
        : `${prefix}I found ${title}.`;

      const wantPayment = args.includePaymentSuggestion === true;
      const productKey = normalizeProductFollowUpKey(title);
      const paymentSuggestionPhrase = pickVariant(`pay_${productKey || title}`, PAYMENT_SUGGESTION_PHRASES);
      const prevOffered =
        typeof args.followUpOfferedProductKey === 'string' && args.followUpOfferedProductKey.trim()
          ? args.followUpOfferedProductKey.trim()
          : null;
      const shouldSoftFollowUp = !wantPayment && prevOffered !== productKey;
      let followUpTriggered = false;
      let text: string;
      if (wantPayment) {
        text = `${core} ${paymentSuggestionPhrase}`;
      } else if (shouldSoftFollowUp) {
        text = `${core} ${paymentSuggestionPhrase}`;
        followUpTriggered = true;
      } else {
        text = core;
      }
      return {
        text,
        templateKey: 'product_found_offer_link',
        toneLeadUsed,
        paymentSuggestionUsed: wantPayment,
        ...(followUpTriggered ? { followUpTriggered: true, followUpOfferedProductKey: productKey } : {}),
      };
    }
    return {
      text: pickVariant(`not_found_${state}`, [
        "I couldn't find an exact match, but I can check similar titles. Could you repeat the title or author?",
        "That exact title didn't come up. Could you spell it or share the author name?",
      ]),
      templateKey: 'product_not_found',
      toneLeadUsed: null,
      paymentSuggestionUsed: false,
    };
  }

  return {
    text: pickVariant('idle_clarify', [
      'Which book do you need? Please tell me the title first.',
      'Tell me the book title and I will check it for you.',
    ]),
    templateKey: 'idle_clarify',
    toneLeadUsed: null,
    paymentSuggestionUsed: false,
  };
}
