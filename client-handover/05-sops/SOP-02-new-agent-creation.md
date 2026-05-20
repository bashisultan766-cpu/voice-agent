# SOP 2 — New voice agent creation

**Purpose:** Create a new voice agent for a store and prepare it for live use.

**Owner:** Operations / Admin  
**Prerequisites:** Store exists; prompt and behavior agreed (tone, rules, tools).

---

## Steps

1. **Choose store** in dashboard; go to Agents (or equivalent) and Create agent.
2. **Set agent role:** Name, description, language (e.g. en, ur).
3. **Write base prompt:** Define role (e.g. bookstore assistant), tone (friendly, concise), and rules (e.g. never invent order status; ask for order # and email/phone before lookup).
4. **Set messages:** Greeting (first thing caller hears), fallback (when agent cannot help), escalation (when handing off to human).
5. **Enable tools:** Select tools this agent may use (e.g. search_books, get_book_details, check_book_inventory, get_order_status, get_store_locations, get_store_hours, search_store_faqs, get_shipping_policy, get_return_policy, get_promotion_details, create_callback_request, handoff_to_human).
6. **Save as draft.** Do not publish yet.
7. **Test with sample scenarios:** Use test number or staging: call and test product question, order question, store hours, return policy, and escalation. Note gaps.
8. **Refine prompt and knowledge:** Add missing FAQs or branch info; adjust prompt if needed.
9. **Publish** the prompt version when satisfied.
10. **Assign number** (if not already): Assign Twilio number to this agent.
11. **Monitor 24–48 hours:** Check analytics and QA for resolution rate, tool failures, escalations.

---

## Validation checklist

- [ ] Agent appears under correct store.
- [ ] All required tools enabled.
- [ ] Greeting and fallback sound correct on a test call.
- [ ] At least one product/order/policy scenario works.
- [ ] Escalation or callback works when triggered.

---

## Common mistakes

- Enabling too many tools and confusing the model; enable only what the store needs.
- Vague prompt (e.g. “be helpful”) without rules on verification, brevity, or escalation.
- Publishing without testing; use draft and test call first.
