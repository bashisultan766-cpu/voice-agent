import type { OrderLookupResult, SpeechChunk, SpeechPlan, StructuredOrder } from "../types/order.js";
import {
  fulfillmentStatusPhrase,
  speakCardLast4,
  speakMoney,
  speakProductList,
} from "../utils/formatter.js";
import { getCachedPhrase } from "../utils/phraseCache.js";

const MAX_WORDS = 15;

function trimWords(text: string, max = MAX_WORDS): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text.trim();
  return `${words.slice(0, max).join(" ")}...`;
}

function itemCountPhrase(count: number): string {
  if (count === 1) return "You've got one item on this order.";
  return `You've got ${count} items on this order.`;
}

function productSnippet(order: StructuredOrder): string | null {
  const detail = speakProductList(order.products);
  if (!detail) return null;
  return trimWords(`That includes ${detail}.`, 14);
}

function statusPhrase(order: StructuredOrder): string {
  const status = fulfillmentStatusPhrase(order.fulfillmentStatus);
  return trimWords(`Right now it's ${status}.`);
}

/** Immediate filler — emitted before Shopify returns. */
export function planInstantFiller(): SpeechChunk {
  return {
    text: getCachedPhrase("checking"),
    kind: "filler",
    pauseMs: 0,
  };
}

/** Fast confirmation — emitted the moment lookup succeeds. */
export function planInstantConfirmation(order: StructuredOrder): SpeechChunk {
  const name = order.customerName?.split(" ")[0];
  if (name) {
    return {
      text: trimWords(`Got it — I found your order under ${name}.`),
      kind: "confirmation",
      pauseMs: 40,
    };
  }
  return {
    text: getCachedPhrase("found_order"),
    kind: "confirmation",
    pauseMs: 40,
  };
}

export function planOrderLookupResponse(order: StructuredOrder): SpeechPlan {
  const tone = order.refund.refunded ? "empathetic" : "warm";
  const chunks: SpeechChunk[] = [];

  const total = speakMoney(order.totalAmount);
  const shipping = speakMoney(order.shippingFee);

  chunks.push({
    text: itemCountPhrase(order.productCount),
    kind: "summary",
    pauseMs: 60,
  });

  const products = productSnippet(order);
  if (products) {
    chunks.push({ text: products, kind: "summary", pauseMs: 50 });
  }

  chunks.push({
    text: trimWords(`Total was ${total}, with ${shipping} shipping.`),
    kind: "summary",
    pauseMs: 60,
  });

  if (order.refund.refunded) {
    chunks.push({
      text: "I'm sorry — this order has been refunded.",
      kind: "refund",
      pauseMs: 80,
    });

    if (order.refund.reason) {
      chunks.push({
        text: trimWords(`The reason on file is ${order.refund.reason}.`),
        kind: "refund",
        pauseMs: 70,
      });
    }

    if (order.refund.refundEmail) {
      chunks.push({
        text: trimWords(`A confirmation was sent to ${order.refund.refundEmail}.`),
        kind: "refund",
        pauseMs: 60,
      });
    }
  } else {
    chunks.push({
      text: trimWords(`Good news — it hasn't been refunded. ${statusPhrase(order)}`),
      kind: "summary",
      pauseMs: 60,
    });
  }

  if (order.payment.cardLast4) {
    const spoken = speakCardLast4(order.payment.cardLast4);
    const brand = order.payment.cardBrand && order.payment.cardBrand !== "card"
      ? order.payment.cardBrand
      : "your card";
    chunks.push({
      text: trimWords(`For security, ${brand} on file ends in ${spoken}.`),
      kind: "payment",
      pauseMs: 70,
    });
  }

  chunks.push({
    text: getCachedPhrase("closing_question"),
    kind: "closing",
    pauseMs: 50,
  });

  return { chunks, tone };
}

export function planLookupError(result: OrderLookupResult): SpeechPlan {
  if (result.status === "invalid_format") {
    return {
      tone: "neutral",
      chunks: [{
        text: "Hmm, I didn't catch a valid order number. Could you try again? It's usually four to six digits.",
        kind: "error",
      }],
    };
  }

  if (result.status === "not_found") {
    return {
      tone: "empathetic",
      chunks: [{
        text: "I'm not seeing that order in our system. Mind double-checking the number?",
        kind: "error",
      }],
    };
  }

  if (result.status === "api_error") {
    return {
      tone: "empathetic",
      chunks: [{
        text: "I'm having a little trouble reaching our order system. Give us a few minutes and try again?",
        kind: "error",
      }],
    };
  }

  return { tone: "neutral", chunks: [] };
}

export function planFollowUpClosing(): SpeechChunk {
  return {
    text: getCachedPhrase("follow_up"),
    kind: "closing",
    pauseMs: 40,
  };
}

export function planGoodbye(): SpeechChunk {
  return {
    text: getCachedPhrase("goodbye"),
    kind: "closing",
    pauseMs: 0,
  };
}

export function planRepeatIntro(): SpeechChunk {
  return {
    text: "Sure — here's what I have on that order.",
    kind: "confirmation",
    pauseMs: 40,
  };
}

export function flattenPlan(plan: SpeechPlan): string {
  return plan.chunks.map((c) => c.text).join(" ");
}
