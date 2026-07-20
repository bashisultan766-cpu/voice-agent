/**
 * Resend transactional email for MailCall checkout-link dispatch and support notes.
 * Prefer authenticated From domain + clean subjects for inbox placement.
 */

import { getConfig } from "../config.js";
import { logger } from "./logger.js";
import {
  DEFAULT_CHECKOUT_URL,
  SUPPORT_EMAIL,
} from "../agents/mailcall/businessRules.js";

export interface ResendSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface CheckoutLinkPayload {
  contactEmail: string;
  checkoutUrl?: string;
  callSid?: string;
}

/** @deprecated Prefer CheckoutLinkPayload — kept for legacy test imports. */
export interface SupportEscalationPayload {
  senderName: string;
  senderEmail: string;
  senderPhone?: string;
  issueSummary?: string;
  newspaperSelection?: "Urban" | "Spanish" | "Global";
  planDuration?: 1 | 3 | 6 | 12;
  callSid?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isResendConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.RESEND_API_KEY?.trim() && cfg.RESEND_FROM_EMAIL?.trim());
}

export function resolveCheckoutUrl(override?: string): string {
  const cfg = getConfig();
  const fromEnv = (cfg.MAILCALL_CHECKOUT_URL ?? "").trim();
  const raw = (override?.trim() || fromEnv || DEFAULT_CHECKOUT_URL).trim();
  return raw.replace(/\/+$/, "") || DEFAULT_CHECKOUT_URL;
}

export function buildCheckoutLinkHtml(details: CheckoutLinkPayload): string {
  const checkoutUrl = resolveCheckoutUrl(details.checkoutUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MailCall Newspaper order link</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:640px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#1e3a5f;padding:20px 24px;">
            <h1 style="margin:0;font-size:20px;color:#fff;font-weight:600;">MailCall Newspaper</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;font-size:15px;line-height:1.55;color:#334155;">
            <p style="margin:0 0 14px;">Hello,</p>
            <p style="margin:0 0 14px;">
              Thank you for calling MailCall Newspaper. Use the button below to open our
              Send Newspaper page and finish your order online.
            </p>
            <p style="margin:0 0 14px;">
              On that page you can enter sender details, inmate details, choose a plan and
              publications, and complete payment.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 24px 28px;">
            <a href="${escapeHtml(checkoutUrl)}"
               style="display:inline-block;background:#1e3a5f;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">
              Continue to Send Newspaper
            </a>
            <p style="margin:16px 0 0;font-size:13px;color:#64748b;word-break:break-all;">
              ${escapeHtml(checkoutUrl)}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f8fafc;font-size:13px;line-height:1.45;color:#64748b;">
            Inmate and facility information is entered only on the website — never over the phone.
            Questions? Reply to this email or write ${escapeHtml(SUPPORT_EMAIL)}.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function buildCheckoutLinkText(details: CheckoutLinkPayload): string {
  const checkoutUrl = resolveCheckoutUrl(details.checkoutUrl);
  return [
    "MailCall Newspaper — order link",
    "",
    "Thank you for calling MailCall Newspaper.",
    "Open this link to finish your order on our Send Newspaper page:",
    checkoutUrl,
    "",
    "On that page you can enter sender details, inmate details, choose a plan and publications, and complete payment.",
    "Inmate and facility information is entered only on the website — never over the phone.",
    "",
    `Questions: ${SUPPORT_EMAIL}`,
    details.callSid ? `Reference: ${details.callSid}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Legacy HTML builder used by older tests — now renders a privacy-safe summary. */
export function buildSupportEscalationHtml(details: SupportEscalationPayload): string {
  const row = (label: string, value: string) =>
    `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e8e8e8;font-weight:600;color:#334155;width:180px;">${escapeHtml(label)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e8e8e8;color:#1a1a1a;">${escapeHtml(value || "Not provided")}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>MailCall Support Note</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:640px;background:#fff;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:#1e3a5f;padding:20px 24px;">
            <h1 style="margin:0;font-size:20px;color:#fff;">MailCall Support Note</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              ${row("Caller name", details.senderName)}
              ${row("Caller email", details.senderEmail)}
              ${row("Caller phone", details.senderPhone ?? "")}
              ${row("Issue summary", details.issueSummary ?? "")}
              ${row("Call SID", details.callSid ?? "")}
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildFromHeader(cfg: ReturnType<typeof getConfig>): string {
  const email = cfg.RESEND_FROM_EMAIL.trim();
  const name = (cfg.RESEND_FROM_NAME || "MailCall Newspaper").trim();
  // Keep display name simple — avoid spammy punctuation / ALL CAPS.
  const safeName = name.replace(/[!?]{2,}/g, "").slice(0, 60);
  return `${safeName} <${email}>`;
}

async function sendResendEmail(input: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
}): Promise<ResendSendResult> {
  const cfg = getConfig();
  if (!cfg.RESEND_API_KEY?.trim() || !cfg.RESEND_FROM_EMAIL?.trim()) {
    return { ok: false, error: "Email service is not configured." };
  }

  const from = buildFromHeader(cfg);
  const replyTo = (input.replyTo || SUPPORT_EMAIL).trim();

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        reply_to: replyTo,
        subject: input.subject,
        html: input.html,
        text: input.text,
        headers: {
          "X-Entity-Ref-ID": input.tags?.find((t) => t.name === "call_sid")?.value ?? "",
        },
        tags: input.tags,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      logger.warn("mailcall_resend_failed", { status: res.status, message: body.message });
      return { ok: false, error: body.message ?? "Could not send email." };
    }

    logger.info("mailcall_resend_ok", { messageId: body.id, to: input.to });
    return { ok: true, messageId: body.id };
  } catch (err) {
    logger.warn("mailcall_resend_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not send email at this time." };
  }
}

/** Dispatch the Send Newspaper checkout link to the caller's verified email. */
export async function sendCheckoutLinkEmail(
  details: CheckoutLinkPayload,
): Promise<ResendSendResult> {
  const checkoutUrl = resolveCheckoutUrl(details.checkoutUrl);
  // Clean, non-spammy subject — avoid "secure", "urgent", "act now", heavy punctuation.
  const subject = "Your MailCall Newspaper order link";
  const html = buildCheckoutLinkHtml({ ...details, checkoutUrl });
  const text = buildCheckoutLinkText({ ...details, checkoutUrl });

  return sendResendEmail({
    to: [details.contactEmail],
    subject,
    html,
    text,
    replyTo: SUPPORT_EMAIL,
    tags: details.callSid
      ? [
          { name: "call_sid", value: details.callSid.slice(0, 64) },
          { name: "purpose", value: "checkout_link" },
        ]
      : [{ name: "purpose", value: "checkout_link" }],
  });
}

/** Privacy-safe support note (no inmate/facility fields). */
export async function sendSupportEscalationEmail(
  details: SupportEscalationPayload,
): Promise<ResendSendResult> {
  const subject = `MailCall support follow-up — ${details.senderName || "Caller"}`;
  const html = buildSupportEscalationHtml(details);
  const text = [
    subject,
    "",
    `Caller name: ${details.senderName || "Not provided"}`,
    `Caller email: ${details.senderEmail || "Not provided"}`,
    `Caller phone: ${details.senderPhone || "Not provided"}`,
    `Issue summary: ${details.issueSummary || "Not provided"}`,
    details.callSid ? `Call SID: ${details.callSid}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return sendResendEmail({
    to: [SUPPORT_EMAIL],
    subject,
    html,
    text,
    replyTo: details.senderEmail || SUPPORT_EMAIL,
  });
}
