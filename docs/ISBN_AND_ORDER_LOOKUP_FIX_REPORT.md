# ISBN and Order Lookup Fix Report

**Date:** 2026-06-26  
**Scope:** ISBN → exact Shopify product search; order number → full Shopify order/refund/tracking details

---

## Summary

Both commerce flows now use real Shopify Admin GraphQL data through canonical tools:

- `search_product_by_isbn(isbn)` — barcode → SKU → metafield → cautious title fallback
- `lookup_shopify_order_details(order_number, email_or_phone)` — privacy-tiered order lookup with pricing, tracking, and refunds

No customer-facing product, price, order, refund, or tracking details are invented by the LLM.

---

## Files Changed

| File | Change |
|------|--------|
| `app/tools/shopify_tools.py` | Added `search_product_by_isbn`, `lookup_shopify_order_details`; helpers for SKU/metafield/tracking/refund parsing; invalid vs partial ISBN detection |
| `app/shopify/graphql_queries.py` | Expanded `LOOKUP_ORDERS` and `SEARCH_VARIANTS_BY_BARCODE` field sets |
| `app/agent_runtime/llm_tools.py` | Registered tools; ISBN catalog_search routes to `search_product_by_isbn`; order status routes to `lookup_shopify_order_details` |
| `app/agents/openai_tool_schema_adapter.py` | Exposed `search_product_by_isbn` and `lookup_shopify_order_details` to Main Commerce Brain |
| `app/runtime/tool_router.py` | Added tools to read-only parallel execution set |
| `app/agents/main_commerce_brain.py` | System prompt mandates canonical ISBN/order tools |
| `app/runtime/fast_classifier.py` | Instant ISBN/title/magazine/newspaper offer reply (no LLM wait) |
| `app/voice/turn_assembler.py` | Zero-digit ISBN hold guard; partial-digit clarify; complete ISBN immediate emit |
| `app/tests/test_isbn_and_order_lookup_fix.py` | 25 new regression tests |
| `app/tests/test_v440_isbn_llm_only.py` | Updated catalog_search ISBN routing assertion |

---

## ISBN Capture Behavior

| Scenario | Behavior |
|----------|----------|
| "Can I give you the ISBN?" | Instant reply: *"Yes, please go ahead and say the ISBN number or title magazine or newspaper."* — no LLM, no hold |
| Spoken digits | `normalize_isbn()` / `expand_spoken_repeaters()` — e.g. *nine seven eight…* → `978…` |
| Spaced ISBN | `978 0 14 312774 1` → `9780143127741` |
| Partial ISBN (4–12 digits) | Hold + clarify: *"I have part of it. Please continue with the remaining digits."* |
| Complete valid ISBN | Turn assembler emits immediately (`is_complete_isbn`) |
| Invalid checksum (10/13 digits) | *"That doesn't look like a valid ISBN. Could you read the full ISBN again?"* |
| Zero digits | Does **not** enter ISBN hold mode |

---

## ISBN Shopify Search Behavior

`search_product_by_isbn` execution order:

1. Redis cache (`isbn_search:{normalized}`)
2. ProductCache ISBN index
3. Variant barcode exact match (`barcode:{isbn}`)
4. Variant SKU exact match (`sku:{isbn}`)
5. Product metafield search (`metafields.book.isbn`, `custom.isbn`, `isbn`)
6. Barcode index fallback via `_search_by_isbn`
7. Title fallback only if all exact paths miss — `confidence: 0.55`, `needs_confirmation: true`

**Found:** `"I found [title] for [$price]. Would you like me to add it to your cart?"`  
**Not found:** `"That ISBN is not showing as available right now. I can forward it to our team to check manually."`

Main Commerce Brain is instructed to call `search_product_by_isbn` for ISBN — not `search_products` or `catalog_search`.

---

## Order Lookup Behavior

`lookup_shopify_order_details(order_number, email_or_phone)`:

| Verification | Returned |
|--------------|----------|
| Order number only | `verification_required: true` — order number, created date, financial/fulfillment/shipping status only |
| Order + email or phone | Full `order` object: items, quantities, pricing, tracking, refunds |

**Unverified message:** *"I can check the basic status. For full details, please confirm the email or phone number on the order."*

**Verified summary includes:** item count, subtotal, shipping, tax, discount, total, fulfillment status, tracking carrier/number, refund date/amount, masked email.

**Privacy:** Full card never exposed; refund card last-4 only via `card_last4_from_transactions`.

---

## GraphQL Fields Added

### `LOOKUP_ORDERS`
- `createdAt`
- `totalTaxSet`, `totalDiscountsSet`, `totalPriceSet`
- Line items: `sku`, `originalUnitPriceSet`, `variant.barcode`
- Fulfillments: `status`, `trackingInfo.company`
- Refunds: `createdAt`, `totalRefundedSet`, `refundLineItems`, refund `transactions.paymentDetails`

### `SEARCH_VARIANTS_BY_BARCODE`
- `product.productType`, `featuredImage.url`
- `product.metafields` (namespace/key/value)

---

## Tests Added

`app/tests/test_isbn_and_order_lookup_fix.py` — 25 tests covering:

1. ISBN offer instant prompt  
2. Spaced ISBN normalization  
3. Spoken digit normalization  
4. Complete ISBN immediate emit  
5. Partial ISBN remaining-digits prompt  
6. Invalid ISBN repeat prompt  
7. Barcode-first Shopify search  
8. SKU fallback  
9. Metafield fallback  
10. Not-found safe message  
11. Uncertain title fallback confirmation  
12. Main brain calls `search_product_by_isbn`  
13. Order number only → limited info  
14. Unverified strips items/pricing/refunds  
15–19. Verified order items, quantities, pricing, tracking, refunds  
20. Refund card last-4 only  
21. Order not found safe message  
22. Main brain calls `lookup_shopify_order_details`  
23. No silence on ISBN question  
24. No silence on order lookup  
25. Tool failure safe fallback  

---

## Test Result

```
python -m compileall app -q          # OK
python -m pytest -q --tb=short       # 763 passed
```

---

## Production Test Phrases

Use these on a live call to validate end-to-end behavior:

1. **"Can I give you the ISBN number?"**  
   → Immediate permission prompt (no silence)

2. **"The ISBN is 9780143127741"**  
   → Real Shopify product lookup via barcode/SKU/metafield

3. **"978 0 14 312774 1"**  
   → Normalized and searched as `9780143127741`

4. **"Check order number 1009"**  
   → Limited status; asks for email/phone for full details

5. **"My order number is 1009 and my email is john dot smith at gmail dot com"**  
   → Full verified order with items, pricing, tracking

6. **"Did I get a refund on order 1009?"**  
   → Verified lookup includes refund amount, date, and masked destination email

---

## Architecture Notes

- Payment safety, email FSM, facility policy, WS auth, rate limits, and main runtime architecture were **not** changed.
- `lookup_order` and `lookup_order_status` remain for backward compatibility; new canonical path is `lookup_shopify_order_details`.
- All Shopify calls use existing `ShopifyGraphQLClient` with retries, circuit breaker, and Redis caching.
