# SOP 5 — Call escalation handling

**Purpose:** Handle calls that were escalated or requested callback in a consistent way and improve future performance.

**Owner:** Support / QA  
**Prerequisites:** Access to Calls and QA review; escalation/callback process defined.

---

## Steps

1. **Check transcript:** Open the call; read full transcript to see what the customer asked and why the agent escalated or offered callback.
2. **Check tool failures:** In the same call view, check tool timeline; note any failed tools (e.g. get_order_status, search_books).
3. **Check KB gaps:** If the agent said “I don’t know” or gave a wrong answer, check if an FAQ or branch profile could have helped; note missing or incorrect content.
4. **Callback / human review:** If a callback was requested, ensure it is logged and assigned per your support process; complete the callback and log outcome.
5. **Mark resolution:** In your ticketing or CRM, mark the escalation as resolved (or document outcome).
6. **Add QA note:** In the platform QA review for this call, add notes; check “needs prompt update” or “needs FAQ update” if content changes are needed.
7. **Follow-up:** If prompt or FAQ update is needed, create a task for Ops (see SOP 2 and SOP 3); schedule update and re-test.

---

## Validation checklist

- [ ] Transcript and tool timeline reviewed.
- [ ] Callback completed (if applicable) and outcome recorded.
- [ ] QA note and flags (prompt/FAQ) set when relevant.
- [ ] Follow-up tasks created for content or config changes.

---

## Common mistakes

- Closing escalation without checking transcript; always review to identify root cause.
- Not flagging “needs prompt update” or “needs FAQ update”; use flags so content owners can improve.
- Treating every escalation as a technical bug; many are content or process (e.g. missing FAQ, unclear prompt).
