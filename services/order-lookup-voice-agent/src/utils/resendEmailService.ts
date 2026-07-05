/**
 * Resend transactional email — checkout links and support escalations.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { ShoppingCartLineItem } from "../types/order.js";
import { formatLineTotal, normalizeShopifyUnitPrice, sumCartMerchandiseTotal } from "./shopifyMoney.js";

export interface ResendSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** Accept any RFC-style email — not limited to Gmail. */
export function isValidCustomerEmail(email: string): boolean {
  const trimmed = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function resendConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.RESEND_API_KEY && cfg.RESEND_FROM_EMAIL);
}

async function sendResendEmail(payload: {
  to: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<ResendSendResult> {
  const cfg = getConfig();
  if (!cfg.RESEND_API_KEY || !cfg.RESEND_FROM_EMAIL) {
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
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      logger.warn("resend_send_failed", { status: res.status, message: body.message });
      return { ok: false, error: body.message ?? "Could not send email." };
    }

    return { ok: true, messageId: body.id };
  } catch (err) {
    logger.warn("resend_send_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not send email at this time." };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoneyDisplay(unitPrice: string | undefined): string {
  return `$${normalizeShopifyUnitPrice(unitPrice)}`;
}

function formatCartTableRows(cart: ShoppingCartLineItem[]): string {
  return cart
    .map((item) => {
      const unitPrice = item.unitPrice ?? item.price;
      const unitDisplay = formatMoneyDisplay(unitPrice);
      const lineTotal = formatLineTotal(unitPrice, item.quantity);
      return `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;color:#1a1a1a;">${escapeHtml(item.title)}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;text-align:center;color:#1a1a1a;">${item.quantity}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;text-align:right;color:#1a1a1a;">${unitDisplay}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #e8e8e8;text-align:right;font-weight:600;color:#1a1a1a;">$${lineTotal}</td>
        </tr>`;
    })
    .join("");
}

function formatCartSummaryText(cart: ShoppingCartLineItem[]): string {
  if (!cart.length) return "No items";
  const lines = cart.map((item) => {
    const unitPrice = item.unitPrice ?? item.price;
    const lineTotal = formatLineTotal(unitPrice, item.quantity);
    return `- ${item.title} x${item.quantity} @ ${formatMoneyDisplay(unitPrice)} = $${lineTotal}`;
  });
  lines.push(`Subtotal: $${sumCartMerchandiseTotal(cart)}`);
  return lines.join("\n");
}

/** Build the HTML checkout invoice body (exported for tests). */
export function buildCheckoutEmailHtml(
  customerName: string,
  invoiceUrl: string,
  cartSummary: ShoppingCartLineItem[],
): string {
  const name = customerName.trim() || "there";
  const subtotal = sumCartMerchandiseTotal(cartSummary);
  const safeUrl = escapeHtml(invoiceUrl.trim());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Sureshot Books Order</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4f6f8;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#1a365d;padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:26px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">Your Sureshot Books Order</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hi ${escapeHtml(name)},</p>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Thank you for your order with Sureshot Books. Review your items below, then complete your secure checkout.</p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:24px;">
                <thead>
                  <tr style="background-color:#f8fafc;">
                    <th style="padding:12px 16px;text-align:left;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:2px solid #e2e8f0;">Product</th>
                    <th style="padding:12px 16px;text-align:center;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:2px solid #e2e8f0;">Qty</th>
                    <th style="padding:12px 16px;text-align:right;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:2px solid #e2e8f0;">Unit Price</th>
                    <th style="padding:12px 16px;text-align:right;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;border-bottom:2px solid #e2e8f0;">Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${formatCartTableRows(cartSummary)}
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan="3" style="padding:16px;text-align:right;font-size:15px;font-weight:600;color:#475569;">Subtotal</td>
                    <td style="padding:16px;text-align:right;font-size:18px;font-weight:700;color:#1a365d;">$${subtotal}</td>
                  </tr>
                </tfoot>
              </table>

              <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#64748b;font-style:italic;">Shipping fees and taxes will be calculated at checkout.</p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="padding:8px 0 24px;">
                    <a href="${safeUrl}" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;font-size:18px;font-weight:700;padding:18px 40px;border-radius:10px;letter-spacing:0.3px;">Complete Secure Checkout</a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">On the checkout page, please enter your <strong>facility and inmate information</strong> so we can deliver your books.</p>
              <p style="margin:0;font-size:14px;line-height:1.6;color:#64748b;">If you have questions, reply to this email or call us back.</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:13px;color:#94a3b8;">&mdash; Sureshot Books</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendCheckoutEmail(
  customerEmail: string,
  customerName: string,
  invoiceUrl: string,
  cartSummary: ShoppingCartLineItem[],
): Promise<ResendSendResult> {
  if (!isValidCustomerEmail(customerEmail)) {
    return { ok: false, error: "Invalid customer email address." };
  }
  if (!invoiceUrl.trim()) {
    return { ok: false, error: "Missing checkout link." };
  }

  const name = customerName.trim() || "there";
  const subject = "Your Sureshot Books Order";
  const html = buildCheckoutEmailHtml(name, invoiceUrl, cartSummary);
  const text = [
    `Hi ${name},`,
    "",
    "Thank you for your order with Sureshot Books.",
    "",
    "Your cart:",
    formatCartSummaryText(cartSummary),
    "",
    "Shipping fees and taxes will be calculated at checkout.",
    "",
    `Complete Secure Checkout: ${invoiceUrl}`,
    "",
    "On the checkout page, please enter your facility and inmate information.",
    "",
    "— Sureshot Books",
  ].join("\n");

  return sendResendEmail({
    to: [customerEmail.trim()],
    subject,
    html,
    text,
  });
}

export async function sendSupportEscalation(
  customerName: string,
  customerEmail: string,
  customerPhone: string,
  llmSummary: string,
): Promise<ResendSendResult> {
  const cfg = getConfig();
  const supportEmail = cfg.SUPPORT_EMAIL;

  const summary = llmSummary.trim() || "No summary provided.";
  const subject = `Voice support escalation — ${customerName.trim() || "Caller"}`;
  const html = `
    <p><strong>Voice agent escalation</strong></p>
    <p><strong>Name:</strong> ${escapeHtml(customerName.trim() || "Not provided")}</p>
    <p><strong>Email:</strong> ${escapeHtml(customerEmail.trim() || "Not provided")}</p>
    <p><strong>Phone:</strong> ${escapeHtml(customerPhone.trim() || "Not provided")}</p>
    <p><strong>Summary:</strong></p>
    <p>${escapeHtml(summary)}</p>
  `;
  const text = [
    "Voice agent escalation",
    `Name: ${customerName.trim() || "Not provided"}`,
    `Email: ${customerEmail.trim() || "Not provided"}`,
    `Phone: ${customerPhone.trim() || "Not provided"}`,
    "",
    "Summary:",
    summary,
  ].join("\n");

  return sendResendEmail({
    to: [supportEmail],
    subject,
    html,
    text,
  });
}

export function isResendAvailable(): boolean {
  return resendConfigured();
}
