import { describe, expect, it } from "vitest";
import { isCatalogShoppingUtterance } from "../src/agents/catalogShoppingIntent.js";
import { resolveCallerIntent } from "../src/agents/callerIntent.js";
import {
  isExplicitTrackingDictationRequest,
  shouldStartTrackingDictation,
} from "../src/agents/trackingIntent.js";
import {
  buildCatalogTargetSystemMessage,
  reconcileAddToCartItems,
  recordLastCatalogSearch,
} from "../src/agents/catalogTarget.js";
import {
  isClosingConversationUtterance,
  shouldOfferEndCallTool,
} from "../src/services/llmService.js";
import { isPaymentLinkActionUtterance } from "../src/agents/lockedFlowState.js";
import { saveActiveOrderContext } from "../src/agents/sessionManager.js";
import type { CallSession } from "../src/types/order.js";

function sessionWithOrderAndCart(callSid: string): CallSession {
  const session = {
    callSid,
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    greetedThisCall: true,
    shoppingCart: [
      {
        title: "Lindy Book",
        quantity: 15,
        variantId: "gid://shopify/ProductVariant/111",
        unitPrice: "19.99",
      },
    ],
    lastCatalogSearch: {
      title: "ISBN Search Book",
      variantId: "gid://shopify/ProductVariant/222",
      unitPrice: "24.99",
      recordedAt: Date.now(),
    },
  } as CallSession;
  saveActiveOrderContext(session, {
    order_number: "21698",
    tracking_number: "1Z999AA10123456784",
  });
  return session;
}

describe("catalog shopping vs tracking hijack", () => {
  it("treats another book / title number as catalog, not tracking", () => {
    const utterance = "I want another book, I have the title number";
    expect(isCatalogShoppingUtterance(utterance)).toBe(true);
    expect(isExplicitTrackingDictationRequest(utterance)).toBe(false);
    expect(
      resolveCallerIntent(utterance, sessionWithOrderAndCart("CA_CATALOG_TITLE")),
    ).toBe("catalog");
  });

  it("does not treat STT id number + book context as tracking", () => {
    const utterance = "I have the id number for the book";
    expect(isCatalogShoppingUtterance(utterance)).toBe(true);
    expect(isExplicitTrackingDictationRequest(utterance)).toBe(false);
  });

  it("blocks tracking dictation when cart is active unless explicit tracking", () => {
    const session = sessionWithOrderAndCart("CA_CART_BLOCK");
    expect(
      shouldStartTrackingDictation("give me the id number", true, { session }),
    ).toBe(false);
    expect(
      shouldStartTrackingDictation("what is my tracking number", true, { session }),
    ).toBe(true);
  });
});

describe("catalog target memory for add_to_cart", () => {
  it("records last search and builds mandatory target message", () => {
    const session = { callSid: "CA_TARGET" } as CallSession;
    recordLastCatalogSearch(session, {
      status: "found",
      bookName: "Fresh Search",
      variantId: "gid://shopify/ProductVariant/999",
      price: "12.50",
    });
    const message = buildCatalogTargetSystemMessage(session);
    expect(message).toMatch(/CURRENT CATALOG TARGET/i);
    expect(message).toMatch(/gid:\/\/shopify\/ProductVariant\/999/);
  });

  it("rebinds stale variant_id to the latest catalog search", () => {
    const session = sessionWithOrderAndCart("CA_REBIND");
    const items = reconcileAddToCartItems(session, [
      {
        variant_id: "gid://shopify/ProductVariant/111",
        title: "Lindy Book",
        quantity: 2,
      },
    ]);
    expect(items[0]?.variant_id).toBe("gid://shopify/ProductVariant/222");
    expect(items[0]?.title).toBe("ISBN Search Book");
  });
});

describe("checkout hangup guards", () => {
  const lockedSession = sessionWithOrderAndCart("CA_LOCKED");

  it("detects payment link requests during cart flow", () => {
    expect(isPaymentLinkActionUtterance("add it to the cart and send me the payment link")).toBe(
      true,
    );
  });

  it("does not treat payment link turns as conversation close when cart is active", () => {
    expect(
      isClosingConversationUtterance(
        "add to cart and send me the payment link",
        [],
        lockedSession,
      ),
    ).toBe(false);
  });

  it("keeps end_call tool available during locked cart flow (hang-up safety)", () => {
    expect(
      shouldOfferEndCallTool({
        userMessage: "thanks",
        session: lockedSession,
      }),
    ).toBe(true);
  });
});
