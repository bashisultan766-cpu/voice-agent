import { describe, expect, it } from "vitest";
import { applySessionCartQuantity } from "../src/agents/orderLookupWorkflow.js";
import {
  getProactiveRecommendation,
  get_proactive_recommendation,
  isProactiveRecommendationDecline,
} from "../src/agents/recommendationEngine.js";
import { tryDeterministicCartTurn } from "../src/agents/agentBrain.js";
import type { CallSession } from "../src/types/order.js";

function makeSession(): CallSession {
  return {
    callSid: "CA_UPSELL",
    from: "+15551234567",
    to: "+15559876543",
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    facilityType: "TX",
  };
}

const SERIES_TAG = "series:A Song of Ice and Fire";

describe("proactive recommendation engine", () => {
  it("suggests the next book in A Song of Ice and Fire after adding A Storm of Swords", () => {
    const session = makeSession();
    session.lastCatalogSearch = {
      title: "A Storm of Swords",
      variantId: "gid://shopify/ProductVariant/storm",
      unitPrice: "14.99",
      recordedAt: Date.now(),
      tags: [SERIES_TAG, "genre:fantasy"],
      metafields: [{ namespace: "custom", key: "series", value: "A Song of Ice and Fire" }],
    };
    session.recommendationCatalog = [
      {
        title: "A Feast for Crows",
        variantId: "gid://shopify/ProductVariant/feast",
        tags: [SERIES_TAG],
        metafields: [{ namespace: "custom", key: "series", value: "A Song of Ice and Fire" }],
        price: "14.99",
      },
      {
        title: "Unrelated Cookbook",
        variantId: "gid://shopify/ProductVariant/cook",
        tags: ["genre:cooking"],
      },
    ];

    const result = applySessionCartQuantity(
      session,
      {
        title: "A Storm of Swords",
        variant_id: "gid://shopify/ProductVariant/storm",
        unit_price: "14.99",
      },
      1,
      "add",
      { facilityType: "TX" },
    );

    expect(result.complianceBlocked).toBeFalsy();
    expect(result.proactiveRecommendation?.title).toBe("A Feast for Crows");
    expect(result.message).toMatch(/A Storm of Swords/i);
    expect(result.message).toMatch(/A Feast for Crows/i);
    expect(result.message).toMatch(/that series/i);
    expect(session.pendingProactiveRecommendation?.variantId).toBe(
      "gid://shopify/ProductVariant/feast",
    );
  });

  it("records declined suggestions and never re-suggests them this call", () => {
    const session = makeSession();
    session.lastCatalogSearch = {
      title: "A Storm of Swords",
      variantId: "gid://shopify/ProductVariant/storm",
      recordedAt: Date.now(),
      tags: [SERIES_TAG],
      metafields: [{ namespace: "custom", key: "series", value: "A Song of Ice and Fire" }],
    };
    session.recommendationCatalog = [
      {
        title: "A Feast for Crows",
        variantId: "gid://shopify/ProductVariant/feast",
        tags: [SERIES_TAG],
        metafields: [{ namespace: "custom", key: "series", value: "A Song of Ice and Fire" }],
      },
    ];

    const first = applySessionCartQuantity(
      session,
      {
        title: "A Storm of Swords",
        variant_id: "gid://shopify/ProductVariant/storm",
      },
      1,
      "add",
      { facilityType: "TX" },
    );
    expect(first.proactiveRecommendation?.title).toBe("A Feast for Crows");

    const declined = tryDeterministicCartTurn(session, "No thanks");
    expect(declined?.speech).toBe("No problem at all.");
    expect(session.sessionDeclinedRecommendations).toEqual(
      expect.arrayContaining([
        "gid://shopify/ProductVariant/feast",
        "A Feast for Crows",
      ]),
    );
    expect(session.pendingProactiveRecommendation).toBeUndefined();

    // Remove and re-add the same title — declined Feast must not return.
    session.shoppingCart = [];
    session.currentSessionCart = {};
    const second = applySessionCartQuantity(
      session,
      {
        title: "A Storm of Swords",
        variant_id: "gid://shopify/ProductVariant/storm",
      },
      1,
      "add",
      { facilityType: "TX" },
    );
    expect(second.proactiveRecommendation).toBeUndefined();
    expect(second.message).not.toMatch(/Feast for Crows/i);
    expect(session.pendingProactiveRecommendation).toBeUndefined();
  });

  it("get_proactive_recommendation skips items already in the cart", () => {
    const rec = get_proactive_recommendation({
      addedSku: "gid://shopify/ProductVariant/storm",
      addedTitle: "A Storm of Swords",
      addedTags: [SERIES_TAG],
      cartVariantIds: [
        "gid://shopify/ProductVariant/storm",
        "gid://shopify/ProductVariant/feast",
      ],
      candidates: [
        {
          title: "A Feast for Crows",
          variantId: "gid://shopify/ProductVariant/feast",
          tags: [SERIES_TAG],
        },
        {
          title: "A Dance with Dragons",
          variantId: "gid://shopify/ProductVariant/dance",
          tags: [SERIES_TAG],
        },
      ],
    });
    expect(rec?.title).toBe("A Dance with Dragons");
  });

  it("stays silent when metadata has no series/genre/author match", () => {
    const rec = getProactiveRecommendation({
      addedSku: "gid://shopify/ProductVariant/1",
      addedTitle: "Lone Title",
      addedTags: ["paperback"],
      cartVariantIds: [],
      candidates: [
        {
          title: "Other Book",
          variantId: "gid://shopify/ProductVariant/2",
          tags: ["hardcover"],
        },
      ],
    });
    expect(rec).toBeNull();
  });

  it("detects decline utterances for pending upsells", () => {
    expect(isProactiveRecommendationDecline("No thanks")).toBe(true);
    expect(isProactiveRecommendationDecline("yes add it")).toBe(false);
  });
});
