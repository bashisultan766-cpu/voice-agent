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
  senderName: string;
  senderEmail: string;
  senderPhone: string;
  inmateName: string;
  inmateNumber: string;
  facilityName: string;
  facilityAddress: string;
  newspaperSelection: "Urban" | "Spanish" | "Global";
  planDuration: 1 | 3 | 6 | 12;
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
<head><meta charset="utf-8" /><title>MailCall Print Plan Intake</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:640px;background:#fff;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="background:#1e3a5f;padding:20px 24px;">
            <h1 style="margin:0;font-size:20px;color:#fff;">MailCall Print Plan Intake</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              ${row("Sender name", details.senderName)}
              ${row("Sender email", details.senderEmail)}
              ${row("Sender phone", details.senderPhone)}
              ${row("Inmate name", details.inmateName)}
              ${row("Inmate ID / number", details.inmateNumber)}
              ${row("Facility name", details.facilityName)}
              ${row("Facility shipping address", details.facilityAddress)}
              ${row("Newspaper selection", `${details.newspaperSelection} edition`)}
              ${row("Plan duration", `${details.planDuration} month${details.planDuration === 1 ? "" : "s"}`)}
              ${row("Call SID", details.callSid ?? "")}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f8fafc;font-size:13px;color:#64748b;">
            Compiled by Brook. Please review manually and execute the print run on the next business day.
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

  const subject = `[MailCall Print Intake] ${details.newspaperSelection} — ${details.planDuration} month${details.planDuration === 1 ? "" : "s"}`;
  const html = buildSupportEscalationHtml(details);
  const text = [
    subject,
    "",
    `Sender name: ${details.senderName || "Not provided"}`,
    `Sender email: ${details.senderEmail || "Not provided"}`,
    `Sender phone: ${details.senderPhone || "Not provided"}`,
    `Inmate name: ${details.inmateName || "Not provided"}`,
    `Inmate ID / number: ${details.inmateNumber || "Not provided"}`,
    `Facility name: ${details.facilityName || "Not provided"}`,
    `Facility shipping address: ${details.facilityAddress || "Not provided"}`,
    `Newspaper selection: ${details.newspaperSelection} edition`,
    `Plan duration: ${details.planDuration} month${details.planDuration === 1 ? "" : "s"}`,
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
