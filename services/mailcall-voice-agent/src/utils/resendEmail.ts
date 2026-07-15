/**
 * Resend transactional email for MailCall support escalations.
 * Reads RESEND_API_KEY / RESEND_FROM_EMAIL from shared env.
 */

import { getConfig } from "../config.js";
import { logger } from "./logger.js";
import { SUPPORT_EMAIL } from "../agents/mailcall/businessRules.js";

export interface ResendSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface SupportEscalationPayload {
  callerName: string;
  callerEmail: string;
  inmateName: string;
  inmateNumber: string;
  facilityName: string;
  facilityAddress: string;
  concern: string;
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

export function buildSupportEscalationHtml(details: SupportEscalationPayload): string {
  const row = (label: string, value: string) =>
    `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e8e8e8;font-weight:600;color:#334155;width:180px;">${escapeHtml(label)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e8e8e8;color:#1a1a1a;">${escapeHtml(value || "Not provided")}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>MailCall Support Escalation</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:640px;background:#fff;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:#1e3a5f;padding:20px 24px;">
            <h1 style="margin:0;font-size:20px;color:#fff;">[MailCall Support Escalation] Inmate Support Request</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              ${row("Caller name", details.callerName)}
              ${row("Caller email", details.callerEmail)}
              ${row("Inmate name", details.inmateName)}
              ${row("Inmate ID / number", details.inmateNumber)}
              ${row("Facility name", details.facilityName)}
              ${row("Facility mailing address", details.facilityAddress)}
              ${row("Main concern", details.concern)}
              ${row("Call SID", details.callSid ?? "")}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f8fafc;font-size:13px;color:#64748b;">
            Submitted by Brook (MailCall voice agent). Please follow up on the next business day.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendSupportEscalationEmail(
  details: SupportEscalationPayload,
): Promise<ResendSendResult> {
  const cfg = getConfig();
  if (!cfg.RESEND_API_KEY?.trim() || !cfg.RESEND_FROM_EMAIL?.trim()) {
    return { ok: false, error: "Email service is not configured." };
  }

  const from = cfg.RESEND_FROM_NAME
    ? `${cfg.RESEND_FROM_NAME} <${cfg.RESEND_FROM_EMAIL}>`
    : cfg.RESEND_FROM_EMAIL;

  const subject = "[MailCall Support Escalation] Inmate Support Request";
  const html = buildSupportEscalationHtml(details);
  const text = [
    subject,
    "",
    `Caller name: ${details.callerName || "Not provided"}`,
    `Caller email: ${details.callerEmail || "Not provided"}`,
    `Inmate name: ${details.inmateName || "Not provided"}`,
    `Inmate ID / number: ${details.inmateNumber || "Not provided"}`,
    `Facility name: ${details.facilityName || "Not provided"}`,
    `Facility mailing address: ${details.facilityAddress || "Not provided"}`,
    `Main concern: ${details.concern || "Not provided"}`,
    details.callSid ? `Call SID: ${details.callSid}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [SUPPORT_EMAIL],
        subject,
        html,
        text,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      logger.warn("mailcall_resend_failed", { status: res.status, message: body.message });
      return { ok: false, error: body.message ?? "Could not send email." };
    }

    logger.info("mailcall_resend_ok", { messageId: body.id, to: SUPPORT_EMAIL });
    return { ok: true, messageId: body.id };
  } catch (err) {
    logger.warn("mailcall_resend_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not send email at this time." };
  }
}
