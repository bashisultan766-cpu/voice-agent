# Incident 2 — Agent giving wrong store info

**Symptom:** Agent gives incorrect store hours, address, branch info, or policy (e.g. wrong branch, outdated hours).

---

## Checks (in order)

1. **Prompt version:** Confirm the live agent is using the intended prompt version; check for recent publish that might have introduced wrong instructions.
2. **FAQ data:** In Knowledge → FAQs, check the store (and branch) FAQs for the topic the customer asked; correct or add the answer.
3. **Branch profile:** In Knowledge → Branch profiles, check the branch’s address, phone, opening hours (e.g. openingHoursJson); fix if wrong.
4. **Knowledge documents:** If the answer comes from a policy or long doc, check the document content and voice summary; update and reindex if vector search is used.
5. **Retrieval logs:** If available, check which FAQ or doc was retrieved for the query; if wrong item is retrieved, improve question wording or add a more specific FAQ.
6. **Tool used:** Confirm the agent is calling the right tool (e.g. get_store_hours, search_store_faqs) and that the tool returns the correct store/branch; fix data or tool logic if needed.

---

## Resolution

- Update FAQs, branch profiles, or documents; reindex if needed. Re-publish prompt only if the prompt text was wrong.
- Retest with a call asking the same question; confirm correct answer.
- Document the fix and, if recurring, consider training or SOP update so content owners keep branch and FAQ data up to date.
