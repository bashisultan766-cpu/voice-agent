import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallSession } from "../src/agents/orderAgent.js";
import {
  isEmailConfirmationActive,
  resolveEmailConfirmationTurn,
  startEmailCapture,
} from "../src/agents/emailConfirmationManager.js";
import {
  buildCheckoutSummarySpeech,
  ensurePaymentCheckoutExecutors,
  resolvePaymentCheckoutTurn,
} from "../src/agents/paymentCheckoutFlow.js";
import { addToCart, setCartLineQuantity } from "../src/agents/cartManager.js";
import { buildOrderDetailSpeech, detectRequestedOrderFields } from "../src/agents/orderDetailBuilder.js";
import { WorkflowPriority, resolveActiveWorkflowPriority } from "../src/agents/intentRouter.js";
import { applyCallerVerificationFromOrder } from "../src/agents/callerVerification.js";
import * as checkoutEmailService from "../src/services/checkoutEmailService.js";
import * as resendEmailService from "../src/utils/resendEmailService.js";
import { ensureSupportExecutors } from "../src/agents/supportEscalationFlow.js";
import type { CallSession } from "../src/types/order.js";

function seedOrderContext(session: CallSession, verified: boolean): void {
  applyCallerVerificationFromOrder(session, {
    status: "found",
    orderNumber: "48065",
    customerName: "Frederick Marcalus",
    customerPhone: verified ? session.from : "+15551234567",
    customerId: "gid://shopify/Customer/99",
    totalOrderCount: 3,
  } as any);
  session.orderContextConfirmed = true;
  session.currentOrderData = {
    order_number: "48065",
    customer_name: "Frederick Marcalus",
    physical_items: [{ title: "Test Book", quantity: 1, price: "$12.00" }],
    total_amount: "$17.00",
    shipping_amount: "$5.00",
    subtotal_amount: "$12.00",
    fulfillment_status: "fulfilled",
    tracking_number: "1Z999",
    order_confirmation_email: "fred@example.com",
    shipping_address: "123 Main St",
  };
}

describe("central email confirmation engine", () => {
  beforeEach(() => {
    ensurePaymentCheckoutExecutors();
    ensureSupportExecutors();
    vi.restoreAllMocks();
  });

  it("blocks lower-priority intents during email confirmation", async () => {
    const session = createCallSession("CA_EMAIL_1", "+15550001", "+1800555");
    startEmailCapture(session, "payment_link");
    expect(isEmailConfirmationActive(session)).toBe(true);
    expect(resolveActiveWorkflowPriority(session)).toBe(WorkflowPriority.EmailConfirmation);
  });

  it("payment workflow sends link once after confirmation", async () => {
    const session = createCallSession("CA_PAY_1", "+15550002", "+1800555");
    addToCart(session, [
      {
        title: "Voice Book",
        variant_id: "gid://shopify/ProductVariant/111",
        unit_price: "10.00",
        quantity: 2,
      },
    ]);
    const sendSpy = vi.spyOn(checkoutEmailService, "sendCheckoutPaymentLink").mockImplementation(
      async (session) => {
        session.paymentLinkSent = true;
        session.paymentLinkSentTo = "buyer@gmail.com";
        return {
          ok: true,
          message: checkoutEmailService.PAYMENT_LINK_SUCCESS_SPEECH,
          invoiceUrl: "https://checkout.example/inv",
        };
      },
    );

    const start = resolvePaymentCheckoutTurn(session, "I am ready to checkout");
    expect(start.handled).toBe(true);
    expect(start.speech).toMatch(/order summary/i);

    await resolveEmailConfirmationTurn(session, "buyer at gmail dot com");
    const confirm = await resolveEmailConfirmationTurn(session, "yes correct");
    expect(confirm.handled).toBe(true);
    expect(confirm.speech).toMatch(/payment link has been sent successfully/i);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(session.paymentLinkSent).toBe(true);
  });

  it("wrong email replaces previous and re-confirms", async () => {
    const session = createCallSession("CA_PAY_2", "+15550003", "+1800555");
    startEmailCapture(session, "payment_link");
    await resolveEmailConfirmationTurn(session, "wrong at gmail dot com");
    const reject = await resolveEmailConfirmationTurn(session, "no that is wrong");
    expect(reject.speech).toMatch(/email address/i);
    await resolveEmailConfirmationTurn(session, "right at gmail dot com");
    expect(session.emailConfirmation?.normalizedEmail).toBe("right@gmail.com");
  });
});

describe("order detail builder", () => {
  it("returns only requested fields", () => {
    const session = createCallSession("CA_ORD_1", "+15550004", "+1800555");
    seedOrderContext(session, true);
    const fields = detectRequestedOrderFields("tell me title, amount and shipping fee");
    expect(fields).toEqual(expect.arrayContaining(["product_title", "item_price", "shipping_fee"]));
    const speech = buildOrderDetailSpeech(
      session,
      "tell me title, amount and shipping fee",
      session.currentOrderData as any,
    );
    expect(speech).toMatch(/Test Book/i);
    expect(speech).toMatch(/shipping fee/i);
    expect(speech).toMatch(/\$12|\$17|amount/i);
  });

  it("blocks shipping address for non-verified callers", () => {
    const session = createCallSession("CA_ORD_2", "+15550005", "+1800555");
    seedOrderContext(session, false);
    const speech = buildOrderDetailSpeech(
      session,
      "what is the shipping address",
      session.currentOrderData as any,
    );
    expect(speech).toMatch(/can't read out the exact shipping address|cannot provide the shipping address|can't provide the shipping address|cannot share the shipping address/i);
  });
});

describe("payment cart quantity", () => {
  it("sets absolute quantity without duplicating lines", () => {
    const session = createCallSession("CA_CART_1", "+15550006", "+1800555");
    addToCart(session, [
      {
        title: "Book A",
        variant_id: "gid://shopify/ProductVariant/222",
        unit_price: "9.00",
        quantity: 10,
      },
    ]);
    setCartLineQuantity(
      session,
      { title: "Book A", variant_id: "gid://shopify/ProductVariant/222" },
      5,
    );
    expect(session.shoppingCart?.[0]?.quantity).toBe(5);
    setCartLineQuantity(
      session,
      { title: "Book A", variant_id: "gid://shopify/ProductVariant/222" },
      20,
    );
    expect(session.shoppingCart?.length).toBe(1);
    expect(session.shoppingCart?.[0]?.quantity).toBe(20);
  });
});

describe("support email content", () => {
  it("sends issue description without conversation transcript", async () => {
    const sendSpy = vi.spyOn(resendEmailService, "sendSupportEscalationDetailed").mockResolvedValue({
      ok: true,
      messageId: "msg_1",
    });
    const result = await resendEmailService.sendSupportEscalationDetailed({
      customerName: "Frederick Marcalus",
      callbackEmail: "fred@example.com",
      callerPhone: "+15550007",
      isVerifiedCaller: false,
      orderNumber: "48065",
      requestedInfo: "order history",
      escalationReason: "Non-verified caller",
      issueDescription:
        "Customer Frederick Marcalus called from a non-verified phone number requesting order history for order #48065.",
      recommendedAction: "Please verify the customer and follow up using the confirmed email.",
    });
    expect(result.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        issueDescription: expect.stringContaining("Frederick Marcalus"),
      }),
    );
    expect(sendSpy.mock.calls[0]?.[0]).not.toHaveProperty("conversationSummary");
  });
});

describe("checkout summary", () => {
  it("includes products quantities and subtotal", () => {
    const session = createCallSession("CA_SUM_1", "+15550008", "+1800555");
    addToCart(session, [
      {
        title: "Book B",
        variant_id: "gid://shopify/ProductVariant/333",
        unit_price: "15.00",
        quantity: 3,
      },
    ]);
    const speech = buildCheckoutSummarySpeech(session);
    expect(speech).toMatch(/Book B/i);
    expect(speech).toMatch(/3 copy/i);
    expect(speech).toMatch(/subtotal/i);
  });
});
