import { describe, expect, it } from "vitest";
import { buildOrderFieldQuerySpeech } from "../src/agents/orderFollowUpSpeech.js";

describe("order field query speech", () => {
  const context = {
    total_amount: "25.00 USD",
    shipping_amount: "4.99 USD",
    item_count: 3,
    physical_items: [
      { title: "Book A", quantity: 1, price: "10.00 USD" },
      { title: "Book B", quantity: 2, price: "7.50 USD" },
    ],
  } as any;

  it("speaks item count, titles, total amount, and shipping for verified callers", () => {
    const speech = buildOrderFieldQuerySpeech(
      "tell me total product, total amount, total shipping fees and product title",
      context,
      true,
    );
    expect(speech).toBeTruthy();
    expect(speech).toMatch(/You ordered 3 book/i);
    expect(speech).toMatch(/Book A/);
    expect(speech).toMatch(/Book B/);
    expect(speech).toMatch(/total is 25\.00 USD/i);
    expect(speech).toMatch(/shipping is 4\.99 USD/i);
  });

  it("refuses totals and fees for unverified callers", () => {
    const speech = buildOrderFieldQuerySpeech(
      "tell me total product, total amount, total shipping fees and product title",
      context,
      false,
    );
    expect(speech).toMatch(/unverified number|public order status and tracking|verified account holder/i);
    expect(speech).not.toMatch(/25\.00|4\.99/i);
  });

  it("includes per-item prices when verified caller asks for product amount", () => {
    const speech = buildOrderFieldQuerySpeech(
      "tell me product title and product amount for each book, and total amount",
      context,
      true,
    );
    expect(speech).toBeTruthy();
    expect(speech).toMatch(/Book A.*10\.00 USD/i);
    expect(speech).toMatch(/Book B.*7\.50 USD/i);
    expect(speech).toMatch(/total is 25\.00 USD/i);
  });

  it("handles how many products, price, and shipping after tracking for verified callers", () => {
    const speech = buildOrderFieldQuerySpeech(
      "how many products did I order, what is their price, and what is the shipping fee",
      context,
      true,
    );
    expect(speech).toBeTruthy();
    expect(speech).toMatch(/3 book/i);
    expect(speech).toMatch(/shipping is 4\.99 USD/i);
  });
});

