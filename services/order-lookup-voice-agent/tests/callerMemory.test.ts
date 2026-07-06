import { describe, expect, it } from "vitest";
import {
  buildCallerWelcomeBackSystemMessage,
  clearCallerMemory,
  getCallerMemory,
  saveCallerMemory,
  CALLER_WELCOME_BACK_GREETING,
} from "../src/utils/callerMemory.js";

describe("callerMemory", () => {
  it("stores and restores caller context by phone suffix", () => {
    const phone = "+15551234567";
    saveCallerMemory({
      phone,
      lastIntent: "order_status",
      shoppingCart: [{ variantId: "v1", productId: "p1", title: "Quran", quantity: 1 }],
      currentOrderData: { order_number: "#48065" },
    });

    const restored = getCallerMemory(phone);
    expect(restored?.lastIntent).toBe("order_status");
    expect(restored?.shoppingCart?.[0]?.title).toBe("Quran");
    expect(restored?.currentOrderData?.order_number).toBe("#48065");

    clearCallerMemory(phone);
    expect(getCallerMemory(phone)).toBeUndefined();
  });

  it("builds welcome-back system instruction with exact greeting", () => {
    expect(buildCallerWelcomeBackSystemMessage()).toContain(CALLER_WELCOME_BACK_GREETING);
  });
});
