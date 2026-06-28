# Order & Refund Full Disclosure Fix Report

**Date:** 2026-06-26  
**Scope:** Shopify order lookup, refund details, customer email/name disclosure, notes, timeline — voice commerce only.

## Summary

Order lookup now returns a **canonical Shopify-backed order object** with complete pricing, items, tracking, refunds, notes, and timeline comments. When the caller provides an **order number** (verified disclosure path), the agent speaks the **full customer email** and refund destination email. Credit cards remain **last-4 only**. Unverified lookups still mask email and strip card/notes.

## Files Changed

| File | Change |
|------|--------|
| `app/shopify/graphql_queries.py` | Extended `LOOKUP_ORDERS` transactions (kind, status, amountSet) and refund line items (`subtotalSet`) |
| `app/shopify/order_privacy.py` | Added `card_brand_from_transactions`, `is_order_disclosure_verified`, `sanitize_order_object`; restored `customer_display_name` |
| `app/tools/shopify_tools.py` | Canonical order builder, full-email customer message, refund schema, `_apply_order_disclosure`, `get_refund_status` full email |
| `app/tests/test_order_refund_full_disclosure.py` | **New** — 18 tests for disclosure, privacy, lookup integration |
| `app/tests/test_isbn_and_order_lookup_fix.py` | Updated refunded-order email assertion (full email) |
| `app/tests/test_v430_production_realworld.py` | Updated suggested-response email assertion |

## Shopify GraphQL Fields Added / Used

On `LOOKUP_ORDERS`:

- Order: `id`, `name`, `createdAt`, `displayFinancialStatus`, `displayFulfillmentStatus`, `email`, `phone`, `note`, `customAttributes`, `cancelledAt`
- `customer { firstName lastName email phone numberOfOrders }`
- `shippingAddress`, `billingAddress`
- `lineItems { title quantity sku originalUnitPriceSet variant { barcode sku } }`
- `subtotalPriceSet`, `totalShippingPriceSet`, `totalTaxSet`, `totalDiscountsSet`, `totalPriceSet`
- `fulfillments { status trackingInfo { company number url } }`
- `refunds { createdAt note totalRefundedSet refundLineItems { quantity subtotalSet lineItem { title } } transactions { kind status gateway amountSet paymentDetails } }`
- `transactions { kind status gateway amountSet paymentDetails }`

Timeline (separate query `GET_ORDER_TIMELINE`):

- `events { BasicEvent.message, CommentEvent.message, CommentEvent.author (StaffMember.name) }`

## Canonical Tool Output (`lookup_shopify_order_details`)

```json
{
  "found": true,
  "verification_required": false,
  "order": {
    "order_number": "#22318",
    "customer_name": "John Smith",
    "customer_email": "john.smith@gmail.com",
    "created_at": "2022-05-20",
    "financial_status": "REFUNDED",
    "fulfillment_status": "FULFILLED",
    "shipping_status": "SUCCESS",
    "tracking": { "carrier": "USPS", "tracking_number": "9400111111", "tracking_url_present": true },
    "items": [{ "title": "Book A", "quantity": 2, "price": "12.50 USD", "sku": "BA-1", "isbn": "9780000000001" }],
    "pricing": { "subtotal": "25.00 USD", "shipping": "0.00 USD", "tax": "2.00 USD", "discount": "1.00 USD", "total": "26.00 USD", "currency": "USD" },
    "refunds": [{
      "refund_date": "2022-05-25",
      "refund_amount": "26.00 USD",
      "refunded_items": ["2x Book A"],
      "destination_email": "john.smith@gmail.com",
      "card_brand": "Visa",
      "card_last4": "1234"
    }],
    "notes": "Ship media mail only",
    "note_attributes": { "inmate_id": "A123" },
    "timeline_comments": []
  },
  "customer_message": "..."
}
```

Legacy aliases (`email_masked`, `order_note`, `payment_card_last4`, etc.) remain for backward compatibility.

## Privacy Behavior

| Field | Verified (order # lookup) | Unverified |
|-------|---------------------------|------------|
| Customer email (spoken) | **Full** — e.g. `john.smith@gmail.com` | Masked — e.g. `j***@gmail.com` |
| Refund destination email | Full order email | Masked |
| Card number | **Last 4 + brand only** | Stripped from payload |
| Order notes / attributes | Included | Redacted |
| Timeline comments | Included | Stripped |

**Verification rule:** Providing an order number is treated as verified disclosure for voice commerce. Email-only lookup requires matching verified caller email on the session.

## Full Email Behavior (Verified)

Example spoken refund summary:

> That order is under John Smith. The refund was processed on 2022-05-25 for 26.00 USD. The refund appears to be linked to the Visa card ending in 1234. Your refund was sent to john.smith@gmail.com. Please check that inbox.

Non-refunded:

> I do not see a refund processed on this order yet. The email on this order is john.smith@gmail.com.

## Refund Behavior

- Refund amount, date, refunded line items, reason (`refund.note`), card brand + last4 from refund transactions.
- `get_refund_status` updated to use the same full-email rules.

## Notes & Comments

- **Order note:** Shopify `order.note` → spoken as “Order note: …”
- **Note attributes:** Shopify `customAttributes` → `note_attributes` dict → spoken as “Order attributes: …”
- **Staff/timeline:** `GET_ORDER_TIMELINE` → `timeline_comments` + spoken “From the Shopify order timeline: …”

## Fields Shopify API Does **Not** Expose

| Requested field | Status |
|-----------------|--------|
| Separate refund destination email | **Not on Refund object** — Shopify Admin API does not return a distinct refund recipient email; we use the order/customer email (standard Shopify refund notice behavior). |
| Full credit card PAN | **Never available** — API returns masked `CardPaymentDetails.number` only (e.g. `****1234`). |
| `noteAttributes` (REST name) | GraphQL equivalent is `customAttributes` on Order — **mapped**. |
| Private staff-only notes outside timeline | Only **CommentEvent** / **BasicEvent** on order timeline are accessible via Admin API. |

## Tests Added

`app/tests/test_order_refund_full_disclosure.py`:

1. Verified order response includes full customer email  
2. Verified order response includes customer name  
3. Refund response includes full destination email  
4. Refund response includes refund amount and date  
5. Card response exposes only last4, never full PAN  
6. Order items include title and quantity  
7. Pricing includes subtotal, shipping, tax, discount, total  
8. Tracking includes carrier and tracking number  
9. Shopify notes included when present  
10. Note attributes included when present  
11. Unverified order masks email in object and speech  
12. Unverified order strips card last4  
13. Missing Shopify fields do not cause hallucination  
14. Main brain uses order lookup tool result  
15–18. Card brand helper, lookup integration, disclosure verification helpers  

## Test Results

```
python -m compileall app -q          # OK
python -m pytest -q --tb=short       # 803 passed
```

## Deploy

Same branch workflow as prior voice-agent deploys:

```bash
cd /var/www/voice-agent
git fetch origin fix/v425-payment-commerce-deploy
git reset --hard FETCH_HEAD
DEPLOY_SKIP_TESTS=1 DEPLOY_GIT_BRANCH=fix/v425-payment-commerce-deploy bash scripts/vps-deploy.sh
pm2 restart twilio-voice-agent
```
