# Incident 3 — Order lookup failing

**Symptom:** Customer provides order number and verification (email/phone) but agent cannot retrieve order status or says it failed.

---

## Checks (in order)

1. **Shopify token:** In store integration, confirm Shopify is connected; check for “token expired” or “invalid” messages. Reconnect per SOP 4 if needed.
2. **Scopes:** Confirm the Shopify app or token has required scopes (e.g. read_orders). Re-authorize with correct scopes if missing.
3. **Recent order visibility:** Confirm the order exists in Shopify and is visible to the app (e.g. not from another store, not deleted). Test with a known order ID in Shopify admin.
4. **Verification rules:** Confirm the platform requires order number + email or phone; check that the agent is sending verification data to the tool and that the tool uses it correctly (e.g. for customer lookup).
5. **Tool logs:** Check call detail for get_order_status: input and output; error message if any. Fix token, scope, or tool logic based on error.
6. **Rate limits:** If Shopify API returns rate limit, implement backoff or inform client of temporary limitation.

---

## Resolution

- Reconnect Shopify (SOP 4) or fix scopes; retest with a known order.
- If tool logic or verification is wrong, fix in code and deploy; retest.
- Document root cause; add monitoring or alert for token expiry if recurring.
