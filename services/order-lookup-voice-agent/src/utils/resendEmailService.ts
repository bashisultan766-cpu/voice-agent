/**
 * Resend transactional email — checkout links and support escalations.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import type { ShoppingCartLineItem } from "../types/order.js";

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

function formatCartSummaryHtml(cart: ShoppingCartLineItem[]): string {
  if (!cart.length) return "<p><em>No items</em></p>";
  const rows = cart
    .map(
      (item) =>
        `<li>${escapeHtml(item.title)} &times; ${item.quantity}` +
        (item.price ? ` — $${escapeHtml(item.price)}` : "") +
        `</li>`,
    )
    .join("");
  return `<ul>${rows}</ul>`;
}

function formatCartSummaryText(cart: ShoppingCartLineItem[]): string {
  if (!cart.length) return "No items";
  return cart
    .map((item) => `- ${item.title} x${item.quantity}${item.price ? ` ($${item.price})` : ""}`)
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const subject = "Your SureShot Books checkout link";
  const html = `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Thank you for your order with SureShot Books. Here is your secure payment link:</p>
    <p><a href="${escapeHtml(invoiceUrl)}">Complete your checkout</a></p>
    <p><strong>Your cart:</strong></p>
    ${formatCartSummaryHtml(cartSummary)}
    <p>On the checkout page, please enter the facility and inmate details so we can deliver your books.</p>
    <p>If you have questions, reply to this email or call us back.</p>
    <p>— SureShot Books</p>
  `;
  const text = [
    `Hi ${name},`,
    "",
    "Thank you for your order with SureShot Books.",
    `Complete your checkout: ${invoiceUrl}`,
    "",
    "Your cart:",
    formatCartSummaryText(cartSummary),
    "",
    "On the checkout page, please enter the facility and inmate details.",
    "",
    "— SureShot Books",
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
