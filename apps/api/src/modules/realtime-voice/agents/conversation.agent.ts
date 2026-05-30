import { Injectable } from '@nestjs/common';
import {
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
} from '../../calls/runtime/voice-email-capture.util';
import type { VoiceGraphState, VoiceIntent } from '../types/voice-turn.types';
import {
  checkoutStageFiller,
  isCheckoutInterrupt,
  isResendPaymentEmailRequest,
  synthesizeCheckoutReply,
} from '../checkout/voice-checkout-flow.util';

const FILLERS: Record<VoiceIntent, string> = {
  greeting: '',
  product_search: 'Let me check that for you…',
  isbn_search: 'One moment while I look up that ISBN…',
  checkout: 'One moment while I prepare your secure checkout link.',
  email_capture: 'Got it — let me verify that email.',
  order_status: 'Let me pull up your order details…',
  support: 'I understand — let me help with that.',
  casual: '',
  unknown: 'One moment…',
};

const SLOW_SEARCH_FILLER = "I'm checking live inventory now.";

@Injectable()
export class ConversationAgent {
  immediateFiller(state: VoiceGraphState): Partial<VoiceGraphState> {
    const session = state.checkoutSession;
    const stageFiller = session?.stage && session.stage !== 'idle' ? checkoutStageFiller(session.stage) : '';
    const filler = stageFiller || FILLERS[state.intent] || FILLERS.unknown;
    return { immediateFiller: filler };
  }

  synthesize(state: VoiceGraphState): Partial<VoiceGraphState> {
    const results = state.agentResults;
    const product = results.find((r) => r.agent === 'shopify_search' || r.agent === 'isbn_search');
    const email = results.find((r) => r.agent === 'email_verification');
    const payment = results.find((r) => r.agent === 'payment_link');
    const memory = results.find((r) => r.agent === 'memory');
    const session = state.checkoutSession;

    if (isCheckoutInterrupt(state.utterance)) {
      return {
        reply: "No problem — we can start fresh. What book are you looking for?",
        modelUsed: 'gpt-4o-mini-template',
      };
    }

    const checkoutReply = synthesizeCheckoutReply(session);
    let reply = checkoutReply ?? '';

    if (!reply) {
      switch (state.intent) {
        case 'greeting': {
          const name = state.context.agent.name ?? 'your bookstore assistant';
          reply =
            state.context.agent.greetingMessage?.trim() ||
            `Hi! Thanks for calling. I'm ${name}. How can I help you find a book today?`;
          break;
        }
        case 'product_search':
        case 'isbn_search': {
          const data = product?.data as {
            products?: Array<{ title: string; price?: string; inStock?: boolean }>;
            slowSearchFiller?: boolean;
            slowSearchMessage?: string;
            exactIsbnMatch?: boolean;
          } | undefined;
          const items = data?.products ?? [];
          if (data?.slowSearchFiller && items.length === 0) {
            reply = data.slowSearchMessage ?? SLOW_SEARCH_FILLER;
            break;
          }
          if (!product?.ok || items.length === 0) {
            reply =
              "I couldn't find an exact match in our catalog. Could you tell me the title or author again?";
          } else if (data?.exactIsbnMatch && items.length === 1) {
            const p = items[0]!;
            reply = `I found an exact ISBN match: "${p.title}"${p.price ? ` for ${p.price}` : ''}. Would you like me to send a checkout link?`;
          } else if (items.length === 1) {
            const p = items[0]!;
            const stock = p.inStock === false ? "It's currently out of stock." : "It's in stock.";
            reply = `I found "${p.title}"${p.price ? ` for ${p.price}` : ''}. ${stock} Would you like me to send a checkout link?`;
          } else {
            const titles = items.slice(0, 3).map((p, i) => `${i + 1}. ${p.title}`).join('; ');
            reply = `I found a few matches: ${titles}. Which one would you like?`;
          }
          if (data?.slowSearchFiller && items.length > 0) {
            reply = `${data.slowSearchMessage ?? SLOW_SEARCH_FILLER} ${reply}`.trim();
          }
          break;
        }
        case 'email_capture': {
          const data = email?.data as {
            valid?: boolean;
            normalized?: string;
            corrected?: boolean;
            spellback?: string;
            rejected?: boolean;
            confirmed?: boolean;
          } | undefined;
          if (data?.rejected || isEmailConfirmationNegative(state.utterance)) {
            reply =
              "No problem. Please spell your email address slowly, including the part after the at sign.";
            break;
          }
          if (data?.confirmed || (session.stage === 'email_confirmation' && isEmailConfirmationAffirmative(state.utterance))) {
            reply = "Perfect — I'll send your secure payment link now.";
            break;
          }
          if (data?.valid && data.normalized) {
            reply =
              data.spellback ??
              `Thanks — I have ${data.normalized}. Is that correct?`;
            if (data.corrected) {
              reply = `I corrected that to ${data.normalized}. ${reply}`;
            }
          } else {
            reply =
              "I didn't catch a valid email. Could you spell it out for me, including the part after the at sign?";
          }
          break;
        }
        case 'checkout': {
          const data = payment?.data as {
            checkoutUrl?: string;
            sent?: boolean;
            resent?: boolean;
            paymentStatus?: string;
            sendError?: string;
            retryExhausted?: boolean;
          } | undefined;

          if (isResendPaymentEmailRequest(state.utterance)) {
            reply = data?.sent
              ? "I've resent the payment link to your email."
              : "I'm resending that payment link now — one moment.";
            break;
          }

          if (data?.paymentStatus === 'completed' || session.paymentStatus === 'completed') {
            reply = 'Great news — your payment went through. Thank you for your order!';
            break;
          }

          if (payment?.error === 'checkout_timeout' || payment?.error === 'agent_timeout') {
            reply = "I'm still preparing your checkout link — I'll have that for you in just a moment.";
            break;
          }

          if (data?.retryExhausted || payment?.error === 'checkout_failed') {
            reply =
              "I had trouble reaching our checkout system. I can try again — what's the best email for your payment link?";
            break;
          }

          if (data?.checkoutUrl) {
            reply = data.sent
              ? "I've sent a secure checkout link to your email. You should receive it shortly."
              : data.sendError
                ? "Your checkout link is ready, but I couldn't send the email yet. Would you like me to resend it?"
                : "I've prepared your checkout link. What's the best email to send it to?";
          } else if (session.stage === 'out_of_stock') {
            reply = session.selected
              ? `"${session.selected.title}" is out of stock. Would you like a similar title instead?`
              : "That item is out of stock. Can I help you find something else?";
          } else if (!session.selected) {
            reply = "I'd love to help you checkout. Which book would you like?";
          } else if (!session.confirmedEmail) {
            reply = "Please tell me your email address so I can send your payment link.";
          } else {
            reply = "One moment while I prepare your secure checkout link.";
          }
          break;
        }
        case 'order_status':
          reply =
            "I can look up order status if you have your order number or the email used at checkout. Do you have either handy?";
          break;
        case 'support':
          reply =
            "I'm here to help. For returns and refunds we follow our store policy — I can explain the steps or connect you with our team.";
          break;
        case 'casual':
          reply = "Happy to chat! Is there a book you're looking for today?";
          break;
        default:
          if (session.stage === 'awaiting_product_selection') {
            reply =
              synthesizeCheckoutReply(session) ??
              'Which title would you like from the list I mentioned?';
          } else if (session.stage === 'payment_pending' && session.paymentLinkSent) {
            reply =
              "Your payment link is on the way. Say 'resend' if you don't see it, or let me know once you've paid.";
          } else {
            reply = "I'm not sure I understood. Are you looking for a book, or help with an order?";
          }
      }
    }

    if (memory?.data && typeof memory.data === 'object') {
      const hint = (memory.data as { promptHint?: string }).promptHint;
      if (hint) reply = `${reply} ${hint}`.trim();
    }

    return { reply, modelUsed: state.escalateToComplexModel ? 'gpt-5' : 'gpt-4o-mini-template' };
  }
}
