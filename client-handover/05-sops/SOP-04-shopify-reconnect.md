# SOP 4 — Shopify token reconnect

**Purpose:** Reconnect a store’s Shopify connection when token is expired, revoked, or rotated.

**Owner:** Operations / Technical  
**Prerequisites:** New token or OAuth flow available; store admin access.

---

## Steps

1. **Open store** in dashboard; go to Integrations or Shopify connection.
2. **Disconnect old token (if needed):** Use “Disconnect” or “Remove connection” so the platform no longer uses the old token. Optionally revoke in Shopify admin if desired.
3. **Start new connection:** Use “Connect Shopify” (OAuth) or “Paste token” (custom app). Complete flow or paste the new token.
4. **Run test connection:** Trigger a test (e.g. fetch store info or one product) to confirm token works.
5. **Validate tools:** Place a test call (or use internal test) and run get_order_status or product search to confirm tools work.
6. **Verify live call:** If already live, place one real test call and ask for order status or product; confirm response is correct.
7. **Document:** Note date of reconnect and who performed it (for audit).

---

## Validation checklist

- [ ] Store shows “Connected” (or equivalent).
- [ ] Test product or order fetch succeeds.
- [ ] At least one voice tool (order or product) works on a test call.
- [ ] No sensitive token visible in UI or logs.

---

## Common mistakes

- Using a token with insufficient scopes; ensure read_orders, read_products (and any other required scopes) are granted.
- Pasting token for wrong store; double-check store and environment (staging vs production).
- Leaving old token in place while adding new one; disconnect first to avoid confusion.
