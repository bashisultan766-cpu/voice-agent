"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPaymentEmailContent = buildPaymentEmailContent;
const payment_email_subject_util_1 = require("./payment-email-subject.util");
function normalizeItems(items) {
    return (items ?? [])
        .map((item) => ({
        title: (item?.title || '').trim() || 'Selected item',
        quantity: Math.max(1, Number(item?.quantity ?? 1) || 1),
        price: item?.price ? String(item.price).trim() : null,
    }))
        .slice(0, 50);
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeText(s) {
    return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function formatItemsText(items) {
    if (!items.length)
        return '• Items selected during your call (see checkout for details)';
    return items.map((i) => `• ${escapeText(i.title)} × ${i.quantity}${i.price ? ` — ${escapeText(i.price)}` : ''}`).join('\n');
}
function formatItemsHtmlRows(items) {
    if (!items.length) {
        return `<tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Items from your call — full details at checkout.</td></tr>`;
    }
    return items
        .map((i) => `
    <tr>
      <td style="padding:12px 14px;border-bottom:1px solid #111111;font-size:14px;color:#111111;">${escapeHtml(i.title)}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #111111;font-size:14px;color:#111111;text-align:right;white-space:nowrap;">× ${i.quantity}${i.price ? ` · ${escapeHtml(i.price)}` : ''}</td>
    </tr>`)
        .join('');
}
function supportBlockText(supportEmail, supportPhone) {
    const lines = [];
    if (supportEmail?.trim())
        lines.push(`Email: ${supportEmail.trim()}`);
    if (supportPhone?.trim())
        lines.push(`Phone: ${supportPhone.trim()}`);
    if (!lines.length)
        return 'Use the contact information from our website if you need help.';
    return lines.join('\n');
}
function supportBlockHtml(supportEmail, supportPhone) {
    const parts = [];
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
function buildPaymentEmailContent(branding) {
    const name = branding.businessName.trim() || 'Our store';
    const safeName = escapeHtml(name);
    const url = branding.checkoutUrl.trim();
    const safeUrlAttr = escapeHtml(url);
    const normalizedItems = normalizeItems(branding.items);
    const itemsText = formatItemsText(normalizedItems);
    const itemsRows = formatItemsHtmlRows(normalizedItems);
    const supportTxt = supportBlockText(branding.supportEmail, branding.supportPhone);
    const supportHtml = supportBlockHtml(branding.supportEmail, branding.supportPhone);
    const subject = branding.subject?.trim() ||
        (0, payment_email_subject_util_1.resolvePaymentEmailSubject)({
            businessName: name,
            subjectTemplate: branding.subjectTemplate,
            envOverride: branding.paymentEmailSubjectEnv,
        }).subject;
    const introBlock = branding.customIntro?.trim()
        ? `${escapeText(branding.customIntro.trim())}\n\n`
        : '';
    const text = `${name}
Secure checkout
${'─'.repeat(Math.min(name.length + 16, 48))}

Hello,

${introBlock}Thank you for your order by phone. Complete payment on Shopify's secure checkout using the link below.

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
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#111111;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#ffffff;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background-color:#ffffff;border:1px solid #111111;">
          <tr>
            <td style="background-color:#111111;padding:28px 32px;">
              <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#ffffff;">Secure checkout</p>
              <h1 style="margin:10px 0 0;font-size:24px;font-weight:700;color:#ffffff;line-height:1.2;letter-spacing:-0.02em;">${safeName}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px;">
              <p style="margin:0 0 16px;font-size:15px;color:#111111;line-height:1.6;">Hello,</p>
              ${branding.customIntro?.trim()
        ? `<p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">${escapeHtml(branding.customIntro.trim())}</p>`
        : ''}
              <p style="margin:0 0 16px;font-size:15px;color:#111111;line-height:1.6;">Thank you for your order by phone. Use the button below to complete payment on Shopify's secure checkout.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px;">
              <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#111111;">Your items</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #111111;">
                ${itemsRows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 32px;" align="center">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background-color:#111111;">
                    <a href="${safeUrlAttr}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:16px 32px;font-size:14px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Complete payment</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:12px;color:#444444;line-height:1.5;">Or copy this link:</p>
              <p style="margin:8px 0 0;word-break:break-all;font-size:12px;color:#111111;"><a href="${safeUrlAttr}" style="color:#111111;text-decoration:underline;">${safeUrlAttr}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;border-top:1px solid #111111;">
              <p style="margin:24px 0 8px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#111111;">Support</p>
              ${supportHtml}
              <p style="margin:16px 0 0;font-size:12px;color:#444444;line-height:1.5;">For your security, we never collect card numbers or CVV codes on the phone.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;border-top:1px solid #111111;">
              <p style="margin:0;font-size:11px;color:#666666;line-height:1.5;">Sent because you requested a payment link during a call with ${safeName}.</p>
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
//# sourceMappingURL=payment-email-templates.js.map