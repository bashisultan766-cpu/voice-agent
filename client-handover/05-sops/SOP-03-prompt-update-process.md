# SOP 3 — Prompt update process

**Purpose:** Safely update an agent’s prompt and publish without breaking live calls.

**Owner:** Operations / Admin  
**Prerequisites:** Access to agent; change request or approved content.

---

## Steps

1. **Open agent** in dashboard; go to prompt / system prompt section.
2. **Create new draft** (if versioning exists) or edit current prompt. Do not publish yet.
3. **Apply changes:** Update base prompt, greeting, fallback, or escalation message as needed. Save draft.
4. **Test internally:** Use test line or staging; run 2–3 sample calls (product, order, policy, escalation). Check transcript and tool usage.
5. **QA review:** If available, have a second person review transcript and behavior.
6. **Publish** the new version when approved.
7. **Monitor 24–48 hours:** Watch analytics (resolution rate, escalation rate, tool failures). Review QA queue for “needs prompt update” flags.
8. **Rollback if needed:** If behavior degrades, revert to previous prompt version (if supported) or restore previous text and re-publish.

---

## Validation checklist

- [ ] Draft saved; not published until tested.
- [ ] At least one test call successful with new prompt.
- [ ] No increase in tool failures or escalations immediately after publish (unless expected).
- [ ] Rollback path known and tested (e.g. previous version restore).

---

## Common mistakes

- Publishing without testing; always test on staging or test number first.
- Making prompt too long; keep it concise for voice and tool use.
- Forgetting to re-enable or disable tools if behavior depends on it.
