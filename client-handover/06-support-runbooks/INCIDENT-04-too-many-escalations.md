# Incident 4 — Too many escalations

**Symptom:** Escalation rate is high; many calls end with handoff or callback instead of resolution.

---

## Checks (in order)

1. **Prompt weakness:** Review recent escalated call transcripts; see if the agent is unclear, too cautious, or missing instructions. Tighten prompt (e.g. when to escalate vs when to offer callback).
2. **Missing FAQs:** Identify common topics in escalated calls; add or improve FAQs for those topics so the agent can answer without escalating.
3. **Missing branch info:** If callers ask branch-specific questions and agent has no data, add or fix branch profiles and branch-scoped FAQs.
4. **Tool timeouts:** Check tool execution timeline; if tools often timeout or fail, agent may escalate. Fix timeouts, retries, or simplify tool usage.
5. **Unclear greeting flow:** If callers are confused at the start, improve greeting and first-turn instructions so the agent sets expectations (e.g. “You can ask about orders, hours, or returns”).
6. **Analytics:** Use analytics dashboard to see escalation rate by agent and store; focus on highest escalation segments first.

---

## Resolution

- Update prompt (SOP 3), add FAQs and branch info, and fix tool or timeout issues as needed.
- Monitor escalation rate for 1–2 weeks after changes; iterate with QA review and “needs prompt update” / “needs FAQ update” flags.
- If certain intents always escalate, consider new tools or dedicated flows in a future version (roadmap).
