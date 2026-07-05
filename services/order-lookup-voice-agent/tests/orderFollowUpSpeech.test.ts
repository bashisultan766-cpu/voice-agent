import { describe, expect, it } from "vitest";
import {
  buildRefundEmailFollowUpSpeech,
  buildRefundNotificationComplaintSpeech,
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
    expect(speech).toContain("inbox and spam folder");
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

  it("returns not-on-file when timeline email is absent", () => {
    expect(
      buildRefundEmailFollowUpSpeech({ refund_notification_email: null, events: [] }, "refund email?"),
    ).toMatch(/not on file/i);
  });
});
