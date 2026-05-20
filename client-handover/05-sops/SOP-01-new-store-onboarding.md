# SOP 1 — New Shopify store onboarding

**Purpose:** Add a new store to the platform and make it ready for live calls.

**Owner:** Operations / Admin  
**Prerequisites:** Twilio number available or assigned; Shopify store admin access; agent content (prompt, FAQs) drafted.

---

## Steps

1. **Create store** in dashboard: name, slug, address, phone, timezone. Save.
2. **Connect Shopify:** Open store integration, start Shopify connection, complete OAuth or paste token. Verify connection (e.g. test product fetch).
3. **Verify product/order access:** Confirm required scopes; run a test order lookup if applicable.
4. **Add branch profiles:** For each branch, add name, city, address, phone, opening hours (JSON or form).
5. **Add FAQs:** Add store-level and, if needed, branch-level FAQs (timings, COD, return policy, etc.).
6. **Assign phone number:** In Phone Numbers, assign the Twilio number to the agent for this store (or create agent first).
7. **Create agent:** Create agent for this store; set base prompt, greeting, fallback, escalation; enable tools (search_books, get_order_status, get_store_hours, search_store_faqs, get_return_policy, etc.).
8. **Publish prompt:** Save and publish the agent’s prompt version.
9. **Test inbound call:** Call the Twilio number; verify greeting, one product/order/policy question, and escalation path if needed.
10. **Go live:** Confirm with client; update any external info (website, IVR) with the number.

---

## Validation checklist

- [ ] Store appears in list; Shopify shows connected.
- [ ] Branch profiles and FAQs visible in Knowledge.
- [ ] Number assigned to correct agent.
- [ ] Test call answered; at least one tool (e.g. store hours or FAQ) works.
- [ ] Escalation or callback path tested.

---

## Common mistakes

- Forgetting to publish the agent after editing prompt.
- Wrong number assigned to wrong agent/store.
- Shopify token expired or insufficient scopes (reconnect per SOP 4).
- Missing branch hours or FAQs so agent says “I don’t know” for common questions.
