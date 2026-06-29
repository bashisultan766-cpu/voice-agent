# Order / Refund / Support Handoff Upgrade Report

**Date:** 2026-06-26  
**Branch context:** `fix/v425-payment-commerce-deploy`  
**Service:** `services/twilio-voice-agent`

## Summary

Consolidated voice-agent escalation to a **single canonical support handoff** path, fixed invalid Shopify GraphQL refund fields, strengthened order lookup customer-safe output, and ensured missing data never produces fabricated answers.

---

## Duplicate escalation removed

| Removed | Replaced by |
|---------|-------------|
| `app/escalation/customer_query_escalation.py` | `app/escalation/support_handoff.py` |
| `app/agent_runtime/customer_query_escalation_flow.py` | `app/agent_runtime/not_found_escalation_flow.py` (expanded) |
| LLM tool `create_customer_query_escalation` | `create_product_not_found_escalation` + `escalate_to_customer_service` |
| `_notify_support_escalation` plain-text Resend email | `send_support_handoff()` |

The duplicate Jessica/backend email path is fully removed. All missing-data cases route through `send_support_handoff()`.

---

## Canonical support handoff upgraded

**Module:** `app/escalation/support_handoff.py`

**Triggers** (after tools tried first):

- Product / ISBN / title not found
- Order not found
- Refund / tracking unavailable
- Shopify API error / tool timeout
- Facility policy unknown
- Customer asks something backend cannot answer reliably

**Customer script:**

> I'm not seeing that information available right now. I can have our support team follow up with you by email. May I have your name and email?

**Support destination** (env, first match wins):

- `SUPPORT_EMAIL`
- `JESSICA_EMAIL`
- `CUSTOMER_SERVICE_EMAIL`
- Fallback: `jessica@sureshotbooks.com` (when unset)

**Email subject:**

`Voice Agent Support Handoff — [Issue Type] — [Customer Name]`

**Email body fields:**

- Customer name, email, phone
- Call SID, Session ID
- Issue type, requested item/order
- What the customer asked
- What the agent tried
- Tool/API result (sanitized)
- Reason for handoff
- Recommended next action
- LLM conversation summary

Secrets (tokens, full card numbers, CVV) are redacted from `api_context` before email send.

---

## Shopify GraphQL fix

**Problem:** Production errors on invalid fields:

- `refunds.orderAdjustments.kind`
- `refunds.orderAdjustments.amountSet`

**Fix:** Removed `orderAdjustments` from `GET_ORDER_WITH_REFUNDS` in `app/shopify/graphql_queries.py`.

**Resilience:** `get_refund_status()` catches refund-query failures and falls back to refund data from the primary `LOOKUP_ORDERS` node so core order/refund answers still work.

**Documented limitation:** Shopify Admin API does not expose `orderAdjustments` on `Refund` in our API version — returned as not requested; adjustments are not available via this query.

---

## Order / refund fields supported

From `LOOKUP_ORDERS` + `_build_full_order_from_node()`:

| Category | Fields |
|----------|--------|
| Customer | name, email (full when verified), phone, shipping address |
| Order | number, date, financial/fulfillment/shipping status, notes, note attributes, timeline |
| Products | titles, qty, SKU, barcode/ISBN, unit price, line total, product count |
| Pricing | subtotal, shipping, tax, discount, total, currency |
| Refund | refunded flag, dates, amounts, items, note, destination email |
| Payment | gateway, card brand, last 4 only |
| Tracking | carrier, number, URL present, fulfillment status |

**Customer-facing speech:** `customer_safe_summary` + filtered `order` object sent to LLM (no raw internal JSON, no `order_id` GID in LLM payload).

**Verified refund example pattern:**

> I found the order under [Name]. The refund was processed on [date] for [amount]. The refund notice was sent to [full email]. The payment card shown is [brand] ending in [last4].

---

## Privacy behavior

- Full customer email spoken only after verified order lookup
- Card: brand + last 4 only; never full PAN or CVV
- Support emails sanitize tokens and full card numbers
- Customer order history only via `get_customer_order_history` when caller asks
- Response sanitizer blocks tool names / system leaks but allows natural order summaries

---

## Response sanitizer

- Tool-name leaks use word-boundary matching (`getorder`, `sendpaymentlink`, etc.)
- Removed overly broad substring checks (`openai`, `llm`) that could false-block valid replies
- Order summaries with email, refund amounts, and card last-4 pass through

---

## Tests added / updated

| # | Test |
|---|------|
| 1 | Duplicate `customer_query_escalation` module removed |
| 2–4 | Canonical handoff: product not found, order not found, API error |
| 5–6 | Name/email collection; email body with LLM summary |
| 7 | Support email excludes secrets |
| 8 | GraphQL query has no `orderAdjustments` |
| 9 | Refund query failure does not break `get_refund_status` |
| 10–11 | Verified order/refund speak full email in safe summary |
| 12 | Card exposes only brand + last4 |
| 13–14 | Pricing and products in order payload |
| 15 | Customer history not in default safe summary |
| 16 | Missing data message says do not invent |
| 17 | Sanitizer allows valid order summary |
| 18 | `customer_facing_order_tool_json` strips internal fields |

**Files:**

- `app/tests/test_support_handoff_upgrade.py` (new)
- `app/tests/test_customer_query_escalation.py` (updated imports)
- `app/tests/test_step5_not_found_escalation.py` (updated patches)
- `app/tests/test_shopify_tools.py` (escalate behavior)

---

## Test results

```
python -m compileall app -q          # OK
python -m pytest -q --tb=short       # 823 passed
```

---

## Remaining Shopify API limitations

1. **`refunds.orderAdjustments`** — not available on `Refund` in current Admin GraphQL schema; removed from query.
2. **Refund destination email** — Shopify does not always expose a separate refund-notification address; we use verified order/customer email and describe it as the email associated with the order/refund notice.
3. **Order timeline** — depends on `GET_ORDER_TIMELINE`; comments/events vary by shop permissions.
4. **Customer lifetime spend / full history** — requires customer search + aggregation; only exposed when caller explicitly asks via `get_customer_order_history`.

---

## Files changed (primary)

- `app/escalation/support_handoff.py` (new)
- `app/escalation/product_not_found_escalation.py`
- `app/escalation/models.py`
- `app/agent_runtime/not_found_escalation_flow.py`
- `app/agent_runtime/order_flow_state.py`
- `app/tools/shopify_tools.py`
- `app/shopify/graphql_queries.py`
- `app/safety/response_sanitizer.py`
- `app/agent_runtime/llm_tools.py`
- `app/agents/main_commerce_brain.py`
- Deleted: `customer_query_escalation.py`, `customer_query_escalation_flow.py`
