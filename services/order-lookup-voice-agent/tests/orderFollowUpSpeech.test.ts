import { describe, expect, it } from "vitest";
import {
  buildLegacyOrderRefundEmailSpeech,
  buildRefundEmailFollowUpSpeech,
  buildRefundNotificationComplaintSpeech,
  isArchivedShopifyTimelineOrder,
  isRefundNotificationEmailQuestion,
  resolveRefundNotificationEmail,
} from "../src/agents/orderFollowUpSpeech.js";

describe("orderFollowUpSpeech refund notification email", () => {
  it("detects the caller phrase for order 21883 style question", () => {
    expect(
      isRefundNotificationEmailQuestion(
        "can you give me the email on which the refunded email notification was sent",
      ),
    ).toBe(true);
  });

  it("detects delivery complaint follow-ups", () => {
    expect(
      isRefundNotificationEmailQuestion(
        "I did not receive the refund notification email from you",
      ),
    ).toBe(true);
  });

  it("re-parses refund email from timeline events when top-level field is null", () => {
    const email = resolveRefundNotificationEmail({
      refund_notification_email: null,
      events: [
        "Darren Herrington sent a refund notification email to joe.customer@gmail.com",
      ],
    });
    expect(email).toBe("joe.customer@gmail.com");
  });

  it("speaks full Shopify timeline email without staff names", () => {
    const speech = buildRefundEmailFollowUpSpeech(
      {
        events: [
          "sent a refund notification email to Blake Penfield (btazp@yahoo.com) on May 28",
        ],
      },
      "What was the refund email?",
    );
    expect(speech.toLowerCase()).toMatch(/btazp.*yahoo/);
    expect(speech).toMatch(/The notification was sent to/i);
    expect(speech).not.toMatch(/Darren|Herrington/i);
  });

  it("responds to did-not-receive complaint with timeline email", () => {
    const speech = buildRefundNotificationComplaintSpeech(
      {
        events: ["Refund notification was sent to zzyxx2002@yahoo.com."],
      },
      "I never got the refund notification",
    );
    expect(speech.toLowerCase()).toMatch(/zzyxx2002.*yahoo/);
    expect(speech).toMatch(/did not receive|understand you did not receive/i);
  });

  it("returns not-on-file when timeline email is absent on a recent order", () => {
    expect(
      buildRefundEmailFollowUpSpeech(
        {
          refund_notification_email: null,
          events: [],
          order_placed_at: "2026-01-15T11:30:00Z",
        },
        "refund email?",
      ),
    ).toMatch(/not on file/i);
  });

  it("applies legacy order fallback for order 21883 style archived timeline", () => {
    const speech = buildRefundEmailFollowUpSpeech(
      {
        refund_notification_email: null,
        events: [],
        order_placed_at: "2022-04-21T16:51:12Z",
        customer_email: "creichtil9@gmail.com",
      },
      "What email was the refund notification sent to?",
    );
    expect(speech).toMatch(/archived by Shopify/i);
    expect(speech).toMatch(/2022/);
    expect(speech.toLowerCase()).toMatch(/creichtil9.*gmail/);
    expect(speech).not.toMatch(/not on file/i);
  });

  it("detects archived orders older than one year", () => {
    expect(isArchivedShopifyTimelineOrder("2022-04-21T16:51:12Z", new Date("2026-07-05"))).toBe(
      true,
    );
    expect(isArchivedShopifyTimelineOrder("2025-06-10T11:30:00Z", new Date("2026-07-05"))).toBe(
      true,
    );
    expect(isArchivedShopifyTimelineOrder("2026-01-15T11:30:00Z", new Date("2026-07-05"))).toBe(
      false,
    );
  });

  it("buildLegacyOrderRefundEmailSpeech returns undefined for recent orders", () => {
    expect(
      buildLegacyOrderRefundEmailSpeech({
        order_placed_at: "2026-01-15T11:30:00Z",
        customer_email: "user@example.com",
      }),
    ).toBeUndefined();
  });
});
