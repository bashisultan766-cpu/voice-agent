import { describe, expect, it } from "vitest";
import {
  buildRefundNotificationEmailSpeech,
  isRefundNotificationEmailQuestion,
} from "../src/agents/orderFollowUpSpeech.js";

describe("orderFollowUpSpeech refund notification email", () => {
  it("detects refund notification email questions", () => {
    expect(isRefundNotificationEmailQuestion("What was the refund email?")).toBe(true);
    expect(isRefundNotificationEmailQuestion("Which email got the refund notification?")).toBe(
      true,
    );
    expect(isRefundNotificationEmailQuestion("Where was my refund sent?")).toBe(true);
    expect(isRefundNotificationEmailQuestion("How many items?")).toBe(false);
  });

  it("speaks full Shopify timeline email without staff names", () => {
    const speech = buildRefundNotificationEmailSpeech({
      refund_notification_email: "jamaicathompson87@gmail.com",
      refund_notification_email_for_tts: "jamaicathompson87 at gmail dot com",
    });
    expect(speech).toContain("jamaicathompson87 at gmail dot com");
    expect(speech).toContain("inbox and spam folder");
    expect(speech).not.toMatch(/Darren|Herrington/i);
  });

  it("returns not-on-file when timeline email is absent", () => {
    expect(buildRefundNotificationEmailSpeech({ refund_notification_email: null })).toMatch(
      /not on file/i,
    );
  });
});
