# Email Deliverability Checklist — SureShot Books

Use this checklist when payment-link emails do not reach the customer inbox.

## DNS & sender authentication

- [ ] **Verify sender domain** in Resend or SendGrid (add domain and complete verification).
- [ ] **Add SPF record** for your sending domain (include Resend/SendGrid in SPF).
- [ ] **Add DKIM record** (provider supplies CNAME/TXT records).
- [ ] **Add DMARC record** (`p=none` to start, then tighten to `quarantine` / `reject` when stable).

## Application configuration

- [ ] **FROM email matches verified domain** — set `FROM_EMAIL=payments@sureshotbooks.com` (or your verified address).
- [ ] **Optional:** set `VERIFIED_EMAIL_DOMAIN=sureshotbooks.com` so the API warns if FROM domain mismatches.
- [ ] **Reply-to email is valid** — use a monitored inbox (e.g. `support@sureshotbooks.com`).
- [ ] **`EMAIL_PROVIDER`** is `resend` or `sendgrid` and the matching API key is set (`RESEND_API_KEY` / `SENDGRID_API_KEY`).

## Shopify

- [ ] **Check Shopify notification settings** — draft-order invoice emails may also send; confirm customer email on the draft order.
- [ ] **Shopify Admin → Orders / Draft orders** — confirm invoice was sent and email address is correct.

## Provider dashboards

- [ ] **Check Resend/SendGrid logs** for bounces, blocks, and deferrals.
- [ ] Note **message ID** from server logs (`email_sent` / `email_provider_response`) and search in the provider UI.

## Inbox testing

- [ ] **Check spam/junk folder** on the customer side.
- [ ] **Test Gmail, Outlook, and Yahoo** with a controlled test address.
- [ ] **Avoid spam trigger words** in subject/body (FREE, URGENT, act now, etc.).
- [ ] **Use a simple email body** — clear subject, one CTA link, plain-text alternative included.

## Server logs (this API)

Search logs for:

- `email_attempted`
- `email_sent` / `email_failed`
- `email_provider_response`

Cross-reference `payment_deliveries.email_status`, `email_message_id`, and `email_error` in the database.

## Voice agent flow

- [ ] Customer email was **confirmed verbally** before `SendPaymentLink` runs.
- [ ] If email fails, agent should ask customer to **repeat email** (never expose internal errors).
