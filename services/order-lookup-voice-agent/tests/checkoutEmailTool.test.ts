import { describe, expect, it, vi } from "vitest";
import type { CallSession } from "../src/types/order.js";
import { executeLlmTool } from "../src/adapters/llmToolExecutor.js";
import { issueConfirmedEmail } from "../src/agents/emailConfirmationManager.js";
import { planCheckoutGroup, cartLinesToGroupLines } from "../src/domain/checkoutModels.js";

const { mockExecuteCheckoutGroup } = vi.hoisted(() => ({
  mockExecuteCheckoutGroup: vi.fn(),
}));

vi.mock("../src/runtime/actionGateway.js", () => ({
  ActionGateway: {
    executeCheckoutGroup: mockExecuteCheckoutGroup,
    createSupportCase: vi.fn(),
    escalateToHuman: vi.fn(),
  },
  executeCheckoutGroup: mockExecuteCheckoutGroup,
}));

function baseSession(callSid: string, cart: CallSession["shoppingCart"]): CallSession {
  return {
    callSid,
    from: "+15551234567",
    to: "+15557654321",
    phase: "cart_active",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    shoppingCart: cart,
    emailConfirmation: {
      confirmationStatus: "confirmed",
      confirmedEmail: "jane@example.com",
      normalizedEmail: "jane@example.com",
    },
  } as unknown as CallSession;
}

describe("send_checkout_email tool execution", () => {
  it("blocks without confirmed_email_id", async () => {
    const session = baseSession("CA_CHEM1", [
      {
        variantId: "gid://shopify/ProductVariant/401",
        productId: "gid://shopify/Product/123",
        title: "Test Book",
        quantity: 1,
        unitPrice: "10.00",
        price: "10.00",
      },
    ]);
    // No confirmed email issued — strip confirmation.
    session.emailConfirmation = {
      confirmationStatus: "capturing",
    } as CallSession["emailConfirmation"];

    const record = await executeLlmTool(
      "send_checkout_email",
      { customerName: "Jane Doe" },
      "CA_CHEM1",
      session,
      { skipPolicy: true },
    );

    expect(record.ok).toBe(false);
    expect(record.status).toBe("blocked");
    expect(record.errorMessage).toMatch(/confirmed_email_id/i);
    expect(mockExecuteCheckoutGroup).not.toHaveBeenCalled();
  });

  it("blocks on empty cart after confirmed email", async () => {
    const session = baseSession("CA_CHEM2", []);
    const confirmed = issueConfirmedEmail(session, "jane@example.com", "payment_link");

    const record = await executeLlmTool(
      "send_checkout_email",
      {
        confirmed_email_id: confirmed.confirmedEmailId,
        customerName: "Jane Doe",
      },
      "CA_CHEM2",
      session,
      { skipPolicy: true },
    );

    expect(record.ok).toBe(false);
    expect(["empty", "blocked"]).toContain(record.status);
    expect(record.errorMessage).toMatch(/empty|cart|group|line/i);
    expect(mockExecuteCheckoutGroup).not.toHaveBeenCalled();
  });

  it("routes through ActionGateway.executeCheckoutGroup on success", async () => {
    mockExecuteCheckoutGroup.mockResolvedValue({
      ok: true,
      checkoutGroupId: "cg_test",
      idempotencyKey: "idem_cg_test",
      status: "sent",
      invoiceUrl: "https://checkout.example/invoice/abc",
      message: "Your payment link has been sent successfully. Please check your inbox.",
      remainingUnits: 0,
    });

    const session = baseSession("CA_CHEM3", [
      {
        variantId: "gid://shopify/ProductVariant/401",
        productId: "gid://shopify/Product/123",
        title: "Test Book",
        quantity: 2,
        unitPrice: "10.00",
        price: "10.00",
      },
    ]);
    const confirmed = issueConfirmedEmail(session, "jane@example.com", "payment_link");
    const planned = planCheckoutGroup(
      session,
      cartLinesToGroupLines(session.shoppingCart!),
    );
    expect(planned.ok).toBe(true);

    const record = await executeLlmTool(
      "send_checkout_email",
      {
        confirmed_email_id: confirmed.confirmedEmailId,
        checkout_group_id: planned.ok ? planned.group.checkoutGroupId : "",
        customerName: "Jane Doe",
      },
      "CA_CHEM3",
      session,
      { skipPolicy: true },
    );

    expect(record.ok).toBe(true);
    expect(record.status).toBe("sent");
    expect(mockExecuteCheckoutGroup).toHaveBeenCalledTimes(1);
    expect(mockExecuteCheckoutGroup.mock.calls[0]![0].confirmedEmailId).toBe(
      confirmed.confirmedEmailId,
    );
  });
});
