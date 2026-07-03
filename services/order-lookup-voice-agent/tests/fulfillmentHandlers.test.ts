import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildBookFoundTts,
  buildOrderStatusTts,
  handleFulfillmentTurn,
} from "../src/agents/fulfillmentHandlers.js";
import { clearAllDialogueStates } from "../src/agents/dialogueManager.js";
import { useLlmAgentMock } from "./helpers/registerLlmMock.js";
import { ORDER_21698_F1_EXPECTED } from "./fixtures/order21698F1.js";

useLlmAgentMock();

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
  it("includes rich order summary with customer email, items, and financials", () => {
    const tts = buildOrderStatusTts({
      status: "found",
      orderNumber: "#12345",
      orderPlacedAt: "2025-03-10T12:00:00Z",
      customerName: "Jane Doe",
      customerEmail: "jane.doe@example.com",
      fulfillmentStatus: "In transit",
      estimatedDeliveryDays: 3,
      trackingStatus: "USPS 9400",
      subtotalAmount: "40.00 USD",
      totalAmount: "45.99 USD",
      shippingFee: "5.99 USD",
      lineItems: [{ title: "Harry Potter", quantity: 2 }],
      itemCount: 2,
      cardLast4: "4242",
      cardBrand: "Visa",
    });
    expect(tts.text).toContain("Jane Doe");
    expect(tts.text).toMatch(/placed on March 10th, 2025/i);
    expect(tts.text).toContain("jane.doe@example.com");
    expect(tts.text).toContain("Your order contains 2 items");
    expect(tts.text).toMatch(/The books cost/i);
    expect(tts.text).toMatch(/shipping was/i);
    expect(tts.text).toMatch(/making the total/i);
    expect(tts.text).toContain("in transit");
    expect(tts.text).toContain("3 days");
    expect(tts.text).toContain("USPS 9400");
    expect(tts.text).not.toContain("Customer");
    expect(tts.text).not.toContain("your card");
  });

  it("reads exact Shopify fields for #21698-F1 without invented fallbacks", () => {
    const tts = buildOrderStatusTts({
      status: "found",
      orderPlacedAt: "2025-04-01T10:00:00Z",
      ...ORDER_21698_F1_EXPECTED,
    });

    expect(tts.text).toContain("Joel Moore");
    expect(tts.text).toMatch(/placed on April 1st, 2025/i);
    expect(tts.text).toContain("joel.moore@gmail.com");
    expect(tts.text).toContain("Your order contains 1 item");
    expect(tts.text).toMatch(/The books cost/i);
    expect(tts.text).toMatch(/shipping was/i);
    expect(tts.text).toContain("OUT OF STOCK");
    expect(tts.text).toContain("zzyxx2002@yahoo.com");
    expect(tts.text).not.toMatch(/refund confirmation email was sent to joel\.moore@gmail\.com/i);
    expect(tts.text).not.toContain("Customer");
    expect(tts.text).not.toMatch(/\bfake\b/i);
  });
});

describe("handleFulfillmentTurn", () => {
  afterEach(() => {
    clearAllDialogueStates();
    vi.clearAllMocks();
  });

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

  it("announces multi-intent plan without calling Shopify", async () => {
    const result = await handleFulfillmentTurn({
      speech:
        "Hi, first I want to check my order status, and then I want to buy a book",
      callSid: "CA_MULTI",
    });

    expect(result.tts.text).toContain("both");
    expect(result.tts.awaitingSlot).toBe("order_number");
    expect(getOrderStatus).not.toHaveBeenCalled();
    expect(searchByTitle).not.toHaveBeenCalled();
  });

  it("uses fuzzy title phrasing when exactMatch is false", () => {
    const tts = buildBookFoundTts({
      status: "found",
      bookName: "Harry Potter and the Sorcerer's Stone",
      price: "12.50",
      inStock: true,
      exactMatch: false,
      queriedTitle: "Harry Potter Sorcerer",
    });
    expect(tts.text).toContain("couldn't find that exact title");
    expect(tts.text).toContain("Harry Potter");
  });
});
