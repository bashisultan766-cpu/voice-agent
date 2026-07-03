import { describe, expect, it, vi } from "vitest";
import {
  buildBookFoundTts,
  buildOrderStatusTts,
  handleFulfillmentTurn,
} from "../src/agents/fulfillmentHandlers.js";

vi.mock("../src/adapters/shopifyStorefrontAdapter.js", () => ({
  getOrderStatus: vi.fn(),
  searchByISBN: vi.fn(),
  searchByTitle: vi.fn(),
}));

import {
  getOrderStatus,
  searchByISBN,
  searchByTitle,
} from "../src/adapters/shopifyStorefrontAdapter.js";

describe("buildBookFoundTts", () => {
  it("formats in-stock offer with price", () => {
    const tts = buildBookFoundTts({
      status: "found",
      bookName: "The Great Gatsby",
      price: "12.50",
      inStock: true,
      quantity: 5,
    });
    expect(tts.text).toContain("The Great Gatsby");
    expect(tts.text).toContain("12");
    expect(tts.text).toContain("in stock");
    expect(tts.text).toContain("add this to your cart");
    expect(tts.offerAddToCart).toBe(true);
  });

  it("reports out of stock without cart offer flag", () => {
    const tts = buildBookFoundTts({
      status: "found",
      bookName: "Rare Book",
      price: "20.00",
      inStock: false,
      quantity: 0,
    });
    expect(tts.text).toContain("out of stock");
    expect(tts.offerAddToCart).toBe(false);
  });
});

describe("buildOrderStatusTts", () => {
  it("includes order number, status, and delivery window", () => {
    const tts = buildOrderStatusTts({
      status: "found",
      orderNumber: "#12345",
      fulfillmentStatus: "In transit",
      estimatedDeliveryDays: 3,
      trackingStatus: "USPS 9400",
    });
    expect(tts.text).toContain("#12345");
    expect(tts.text).toContain("in transit");
    expect(tts.text).toContain("3 days");
    expect(tts.text).toContain("USPS 9400");
  });
});

describe("handleFulfillmentTurn", () => {
  it("returns ISBN fallback when book not found", async () => {
    vi.mocked(searchByISBN).mockResolvedValue({ status: "not_found" });

    const result = await handleFulfillmentTurn({
      speech: "ISBN 9783161484100",
      callSid: "CA_TEST",
    });

    expect(result.tts.text).toContain("couldn't find a book with that ISBN");
    expect(result.tts.awaitingSlot).toBe("title");
  });

  it("returns order status TTS on successful lookup", async () => {
    vi.mocked(getOrderStatus).mockResolvedValue({
      status: "found",
      orderNumber: "#54321",
      fulfillmentStatus: "shipped",
      estimatedDeliveryDays: 2,
    });

    const result = await handleFulfillmentTurn({
      speech: "track order 54321",
      callSid: "CA_TEST",
    });

    expect(result.tts.text).toContain("#54321");
    expect(result.tts.text).toContain("shipped");
  });

  it("returns title search fallback on not found", async () => {
    vi.mocked(searchByTitle).mockResolvedValue({ status: "not_found" });

    const result = await handleFulfillmentTurn({
      speech: "do you have Moby Dick",
      callSid: "CA_TEST",
    });

    expect(result.tts.text).toContain("couldn't find a book matching that title");
    expect(result.tts.awaitingSlot).toBe("isbn");
  });
});
