/**
 * Resend transactional email for MailCall checkout-link dispatch and support notes.
 * Reads RESEND_API_KEY / RESEND_FROM_EMAIL from shared env.
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
  newspaperSelection: "Urban" | "Spanish" | "Global";
  planDuration: 1 | 3 | 6 | 12;
  packageType: "Single Edition" | "Bundle of Two" | "Bundle of Three";
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

function planLabel(months: number): string {
  return months === 1 ? "1 Month" : `${months} Months`;
}

export function buildCheckoutLinkHtml(details: CheckoutLinkPayload): string {
  const checkoutUrl = resolveCheckoutUrl(details.checkoutUrl);
  const row = (label: string, value: string) =>
    `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e8e8e8;font-weight:600;color:#334155;width:200px;">${escapeHtml(label)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e8e8e8;color:#1a1a1a;">${escapeHtml(value)}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>MailCall Secure Checkout Link</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:640px;background:#fff;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:#1e3a5f;padding:20px 24px;">
            <h1 style="margin:0;font-size:20px;color:#fff;">Your MailCall Checkout Link</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 24px;font-size:15px;line-height:1.5;color:#334155;">
            Thank you for calling MailCall Newspaper. Use the secure button below to open our
            Send Newspaper page. There you can enter sender details, inmate details, choose your
            subscription plan, package type, and publications, then complete payment safely online.
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              ${row("Publication", `${details.newspaperSelection} edition`)}
              ${row("Plan", planLabel(details.planDuration))}
              ${row("Package", details.packageType)}
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px;">
            <a href="${escapeHtml(checkoutUrl)}"
               style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;">
              Open Secure Checkout
            </a>
            <p style="margin:16px 0 0;font-size:13px;color:#64748b;word-break:break-all;">
              ${escapeHtml(checkoutUrl)}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f8fafc;font-size:13px;color:#64748b;">
            For privacy, inmate and facility information is entered only on this secure page — never over the phone.
            Questions? Email ${escapeHtml(SUPPORT_EMAIL)}.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
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

async function sendResendEmail(input: {
  to: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<ResendSendResult> {
  const cfg = getConfig();
  if (!cfg.RESEND_API_KEY?.trim() || !cfg.RESEND_FROM_EMAIL?.trim()) {
    return { ok: false, error: "Email service is not configured." };
  }

  const from = cfg.RESEND_FROM_NAME
    ? `${cfg.RESEND_FROM_NAME} <${cfg.RESEND_FROM_EMAIL}>`
    : cfg.RESEND_FROM_EMAIL;

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
        subject: input.subject,
        html: input.html,
        text: input.text,
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
  const subject = `Your MailCall secure checkout link — ${details.newspaperSelection} · ${planLabel(details.planDuration)}`;
  const html = buildCheckoutLinkHtml({ ...details, checkoutUrl });
  const text = [
    subject,
    "",
    "Open this secure link to complete your order on our Send Newspaper page:",
    checkoutUrl,
    "",
    `Publication: ${details.newspaperSelection}`,
    `Plan: ${planLabel(details.planDuration)}`,
    `Package: ${details.packageType}`,
    "",
    "Enter sender details, inmate details, and payment securely on the website — we do not collect inmate or facility information over the phone.",
    details.callSid ? `Call reference: ${details.callSid}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return sendResendEmail({
    to: [details.contactEmail],
    subject,
    html,
    text,
  });
}

/** Privacy-safe support note (no inmate/facility fields). */
export async function sendSupportEscalationEmail(
  details: SupportEscalationPayload,
): Promise<ResendSendResult> {
  const subject = `[MailCall Support] ${details.senderName || "Caller"}`;
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
  });
}
