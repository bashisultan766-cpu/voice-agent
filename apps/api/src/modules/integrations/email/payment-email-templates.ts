/**
 * Branded transactional templates for secure checkout / payment-link emails.
 * HTML uses tables + inline styles for broad client support; text is always included for accessibility.
 */

export type PaymentEmailItem = { title: string; quantity: number; price?: string | null };

export type PaymentEmailBranding = {
  businessName: string;
  supportEmail?: string | null;
  supportPhone?: string | null;
  /** Public HTTPS checkout URL */
  checkoutUrl: string;
  items: PaymentEmailItem[];
};

function normalizeItems(items: PaymentEmailItem[]): PaymentEmailItem[] {
  return (items ?? [])
    .map((item) => ({
      title: (item?.title || '').trim() || 'Selected item',
      quantity: Math.max(1, Number(item?.quantity ?? 1) || 1),
      price: item?.price ? String(item.price).trim() : null,
    }))
    .slice(0, 50);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain-text safe (no HTML entities). */
function escapeText(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function formatItemsText(items: PaymentEmailItem[]): string {
  if (!items.length) return '• Items selected during your call (see checkout for details)';
  return items.map((i) => `• ${escapeText(i.title)} × ${i.quantity}${i.price ? ` — ${escapeText(i.price)}` : ''}`).join('\n');
}

function formatItemsHtmlRows(items: PaymentEmailItem[]): string {
  if (!items.length) {
    return `<tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Items from your call — full details at checkout.</td></tr>`;
  }
  return items
    .map(
      (i) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;">${escapeHtml(i.title)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;text-align:right;white-space:nowrap;">× ${i.quantity}${i.price ? ` · ${escapeHtml(i.price)}` : ''}</td>
    </tr>`,
    )
    .join('');
}

function supportBlockText(supportEmail?: string | null, supportPhone?: string | null): string {
  const lines: string[] = [];
  if (supportEmail?.trim()) lines.push(`Email: ${supportEmail.trim()}`);
  if (supportPhone?.trim()) lines.push(`Phone: ${supportPhone.trim()}`);
  if (!lines.length) return 'Use the contact information from our website if you need help.';
  return lines.join('\n');
}

function supportBlockHtml(supportEmail?: string | null, supportPhone?: string | null): string {
  const parts: string[] = [];
  if (supportEmail?.trim()) {
    const e = escapeHtml(supportEmail.trim());
    parts.push(`<a href="mailto:${e}" style="color:#2563eb;text-decoration:none;">${e}</a>`);
  }
  if (supportPhone?.trim()) {
    const p = escapeHtml(supportPhone.trim());
    const tel = supportPhone.trim().replace(/[^\d+]/g, '');
    parts.push(`<a href="tel:${escapeHtml(tel)}" style="color:#2563eb;text-decoration:none;">${p}</a>`);
  }
  if (!parts.length) {
    return '<p style="margin:0;font-size:13px;color:#6b7280;">Need help? Visit our store site or reply if your mail client allows.</p>';
  }
  return `<p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">${parts.join(' · ')}</p>`;
}

export function buildPaymentEmailContent(branding: PaymentEmailBranding): {
  subject: string;
  html: string;
  text: string;
  bodyPreview: string;
} {
  const name = branding.businessName.trim() || 'Our store';
  const safeName = escapeHtml(name);
  const url = branding.checkoutUrl.trim();
  const safeUrlAttr = escapeHtml(url);
  const normalizedItems = normalizeItems(branding.items);
  const itemsText = formatItemsText(normalizedItems);
  const itemsRows = formatItemsHtmlRows(normalizedItems);
  const supportTxt = supportBlockText(branding.supportEmail, branding.supportPhone);
  const supportHtml = supportBlockHtml(branding.supportEmail, branding.supportPhone);

  const subject = `${name} — Complete your secure checkout`;

  const text = `${name}
Secure checkout
${'─'.repeat(Math.min(name.length + 16, 48))}

Hello,

Thank you for your order by phone. Complete payment on Shopify's secure checkout using the link below.

YOUR ITEMS
${itemsText}

COMPLETE PAYMENT (secure link):
${url}

If the link above does not open, copy and paste it into your browser address bar.

QUESTIONS?
${supportTxt}

We never ask for full card numbers on the phone — you'll enter payment details only on the secure checkout page.

— ${escapeText(name)}

This message was sent because you requested a payment link during a call with ${escapeText(name)}.
`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeName} — Checkout</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f3f4f6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#111827 0%,#1f2937 100%);padding:24px 28px;">
              <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#9ca3af;">Secure checkout</p>
              <h1 style="margin:8px 0 0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.25;">${safeName}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;">
              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">Hello,</p>
              <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">Thank you for your order by phone. Use the button below to pay securely on Shopify — the same trusted checkout millions of stores use.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 20px;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">Your items</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                ${itemsRows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 24px;" align="center">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="border-radius:8px;background-color:#111827;">
                    <a href="${safeUrlAttr}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Complete secure payment</a>
                  </td>
                </tr>
              </table>
              <p style="margin:20px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">Prefer to copy the link? Use this plain address:</p>
              <p style="margin:8px 0 0;word-break:break-all;font-size:13px;color:#2563eb;"><a href="${safeUrlAttr}" style="color:#2563eb;">${safeUrlAttr}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 24px;border-top:1px solid #e5e7eb;">
              <p style="margin:20px 0 8px;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">Support</p>
              ${supportHtml}
              <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;line-height:1.5;">For your security, we never collect full card numbers or CVV codes on the phone. Enter payment details only on the checkout page.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.5;">This email was sent because you asked for a payment link during a call with ${safeName}.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const bodyPreview = text.split('\n').slice(0, 4).join(' ').slice(0, 220);

  return { subject, html, text, bodyPreview };
}
