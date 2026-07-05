import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  enrichOrderNodeTimeline,
  orderGidToNumericId,
} from "../src/adapters/shopifyOrderTimeline.js";

vi.mock("../src/tools/shopifyLiveSearch.js", () => ({
  shopifyGraphql: vi.fn(),
}));

import { shopifyGraphql } from "../src/tools/shopifyLiveSearch.js";

describe("orderGidToNumericId", () => {
  it("parses Admin GraphQL order gid", () => {
    expect(orderGidToNumericId("gid://shopify/Order/618806837270")).toBe("618806837270");
  });
});

describe("enrichOrderNodeTimeline", () => {
  beforeEach(() => {
    vi.mocked(shopifyGraphql).mockReset();
  });

  it("skips enrichment when search query already returned events", async () => {
    const node = {
      id: "gid://shopify/Order/1",
      name: "#21883",
      events: {
        edges: [{ node: { message: "Refund notification was sent to a@b.com" } }],
      },
    };

    const enriched = await enrichOrderNodeTimeline(node);
    expect(shopifyGraphql).not.toHaveBeenCalled();
    expect(enriched.events?.edges).toHaveLength(1);
  });

  it("fetches timeline via order(id:) GraphQL when search events are empty", async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({
      order: {
        events: {
          nodes: [
            {
              message:
                "sent a refund notification email to Cheryl Reich-Tillman (creichtil9@gmail.com)",
              action: "mail_sent",
              createdAt: "2022-04-21T16:51:12Z",
            },
          ],
        },
      },
    });

    const enriched = await enrichOrderNodeTimeline({
      id: "gid://shopify/Order/12345",
      name: "#21883",
      events: { edges: [] },
    });

    expect(shopifyGraphql).toHaveBeenCalled();
    expect(enriched.events?.edges).toHaveLength(1);
    expect(enriched.events?.edges?.[0]?.node?.message).toMatch(/creichtil9@gmail.com/);
  });
});
