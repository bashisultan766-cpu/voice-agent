/**
 * UnifiedToolRegistry — Zod policy + secure session injection.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  executeUnifiedTool,
  UnifiedToolRegistry,
  UNIFIED_OPENAI_TOOL_SCHEMAS,
  injectSecureToolContext,
  prepareUnifiedToolArgs,
} from "../src/adapters/unifiedToolRegistry.js";
import { toolResultForLlm } from "../src/adapters/llmToolExecutor.js";
import { ServiceRegistry } from "../src/sovereign/serviceRegistry.js";
import {
  registerUnifiedSession,
  unregisterUnifiedSession,
} from "../src/agents/unifiedCallSession.js";
import type { CallSession } from "../src/types/order.js";
import type { EmailConfirmationContext } from "../src/agents/emailConfirmationManager.js";

function makeSession(overrides: Partial<CallSession> = {}): CallSession {
  const session = {
    callSid: "CA_unified_tool_test",
    from: "+15551234567",
    to: "+15557654321",
    callerPhone: "+15551234567",
    isVerifiedCaller: true,
    phase: "follow_up",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    awaitingInput: null,
    shopifyCustomerId: "gid://shopify/Customer/999",
    ...overrides,
  } as CallSession;
  registerUnifiedSession(session);
  return session;
}

describe("UnifiedToolRegistry", () => {
  afterEach(() => {
    unregisterUnifiedSession("CA_unified_tool_test");
  });

  it("exposes OpenAI function schemas for every registered tool", () => {
    expect(UNIFIED_OPENAI_TOOL_SCHEMAS.length).toBeGreaterThanOrEqual(11);
    expect(UnifiedToolRegistry.has("get_shopify_order_status")).toBe(true);
    expect(UnifiedToolRegistry.has("search_shopify_book_by_isbn")).toBe(true);
    expect(UnifiedToolRegistry.has("send_checkout_email")).toBe(true);
  });

  it("rejects invalid ISBN before any catalog call", async () => {
    const session = makeSession();
    const record = await executeUnifiedTool(
      "search_shopify_book_by_isbn",
      { isbn: "not-an-isbn" },
      session.callSid,
      session,
    );
    expect(record.ok).toBe(false);
    expect(record.status).toBe("invalid_format");
    expect(record.errorMessage).toMatch(/Validation Error:.*ISBN must be 10 or 13 digits/i);
  });

  it("rejects a 13-digit ISBN passed as an order number", async () => {
    const session = makeSession();
    const record = await executeUnifiedTool(
      "get_shopify_order_status",
      { orderNumber: "9780143127741" },
      session.callSid,
      session,
    );
    expect(record.ok).toBe(false);
    expect(record.status).toBe("invalid_format");
    expect(record.errorMessage).toMatch(/Validation Error:.*ISBN/i);
  });

  it("rejects an ISBN hallucinated as a tracking ID on dictate_tracking", async () => {
    const session = makeSession();
    const prepared = prepareUnifiedToolArgs(
      "dictate_tracking",
      { trackingNumber: "9780143127741" },
      session.callSid,
      session,
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.record.errorMessage).toMatch(/Validation Error:.*ISBN/i);
    }
  });

  it("surfaces validation errors to the LLM for self-correction", async () => {
    const session = makeSession();
    const record = await executeUnifiedTool(
      "search_shopify_book_by_isbn",
      { isbn: "123" },
      session.callSid,
      session,
    );
    const payload = JSON.parse(toolResultForLlm(record)) as {
      error: string;
      message: string;
    };
    expect(payload.error).toBe("validation_error");
    expect(payload.message).toMatch(/Validation Error:/);
  });

  it("injects shopifyCustomerId from UnifiedCallSession for history", () => {
    const session = makeSession({
      shopifyCustomerId: "gid://shopify/Customer/SESSION_WINS",
    });
    const injected = injectSecureToolContext(
      "get_customer_history",
      { customerId: "gid://shopify/Customer/LLM_HALLUCINATED" },
      session,
    );
    expect(injected.customerId).toBe("gid://shopify/Customer/SESSION_WINS");
    expect(injected.isVerifiedCaller).toBeUndefined();
  });

  it("injects confirmed checkout email from session over LLM args", () => {
    const emailConfirmation: EmailConfirmationContext = {
      workflowType: "payment_link",
      phase: "confirmed",
      confirmedEmail: "verified@example.com",
      normalizedEmail: "verified@example.com",
      confirmationStatus: "confirmed",
      sentStatus: "pending",
    };
    const session = makeSession({ emailConfirmation });
    const injected = injectSecureToolContext(
      "send_checkout_email",
      { customerEmail: "attacker@evil.com", customerName: "Sam" },
      session,
    );
    expect(injected.customerEmail).toBe("verified@example.com");
  });

  it("strips LLM-supplied isVerifiedCaller claims", () => {
    const session = makeSession({ isVerifiedCaller: false });
    const injected = injectSecureToolContext(
      "get_customer_history",
      { isVerifiedCaller: true, customerId: "x" },
      session,
    );
    expect(injected.isVerifiedCaller).toBeUndefined();
  });

  it("ServiceRegistry routes through executeUnifiedTool", async () => {
    const session = makeSession();
    const record = await ServiceRegistry.executeTool(
      "search_shopify_book_by_isbn",
      { isbn: "abc" },
      session.callSid,
      session,
    );
    expect(record.status).toBe("invalid_format");
    expect(record.errorMessage).toMatch(/Validation Error:/);
  });
});
