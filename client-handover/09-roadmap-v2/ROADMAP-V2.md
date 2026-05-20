# Roadmap v2 — AI Voice Agents platform

Post-launch feature priorities and themes. Order and scope may change based on client feedback and capacity.

---

## Themes

1. **Multilingual and localization** — Urdu/English and city-specific behavior.
2. **Reach and channels** — Outbound callbacks, WhatsApp/chat.
3. **Integrations** — CRM/helpdesk, deeper Shopify.
4. **Intelligence and ops** — Better analytics, QA, human handoff.
5. **Autonomy** — Workflows that create tickets, follow-ups, notifications.

---

## v2.1 — Multilingual support

- **Urdu + English** switching per agent or per call.
- **City-specific language** (e.g. default Urdu in some cities, English in others).
- **Priority for this client:** High (bookstore audience).

---

## v2.2 — Callback automation

- **Missed-call recovery:** Automatically call back when a call is missed or abandoned.
- **Scheduled callbacks:** Agent offers “we’ll call you back at X time” and system places outbound call.
- **Priority for this client:** High.

---

## v2.3 — CRM / helpdesk integration

- **HubSpot, Zoho, Freshdesk, Zendesk:** Create ticket or contact on escalation; sync callback request.
- **Bidirectional:** Update ticket status from platform; show ticket context to agent (if safe).
- **Priority for this client:** High for support workflow.

---

## v2.4 — WhatsApp / chat channel

- **Unified omnichannel inbox:** Voice + WhatsApp (and optionally other chat) in one place.
- **Same agent logic** (prompt, tools, KB) for text where applicable.
- **Priority for this client:** High for reach.

---

## v2.5 — Advanced analytics

- **Intent clustering:** Group calls by intent; top intents and failed intents.
- **Conversion-style analytics:** Callback request rate, resolution by intent.
- **Store-level heatmaps:** Performance by store/branch and time.
- **Priority for this client:** Medium–high.

---

## v2.6 — Human live transfer and supervisor

- **Live transfer:** Escalation connects to human agent (e.g. Twilio task router or similar).
- **Supervisor console:** Supervisor sees live transcript and can whisper/barge.
- **Agent co-pilot:** Human gets AI-suggested answers or KB snippets.
- **Priority for this client:** Medium.

---

## v2.7 — Autonomous workflows

- **Support ticket creation** from escalation or callback request.
- **Inventory / backorder follow-up:** Automatic outbound or notification when stock/backorder changes.
- **Scheduled reminders:** e.g. “We’ll call you when the book arrives.”
- **Priority for this client:** Medium (after core channels and integrations).

---

## Recommended delivery order (for this client)

1. **v2.1** — Multilingual (Urdu/English).
2. **Better branch-level knowledge** (already partly in place; refine and extend).
3. **v2.2** — Callback automation.
4. **v2.3** — CRM integration.
5. **v2.4** — WhatsApp support.
6. **v2.5** — Advanced analytics and QA scoring.
7. **v2.6** — Live transfer and supervisor tools when support volume justifies.

---

## Out of scope for v2 (or later)

- Full custom NLU replacement for OpenAI (stay with OpenAI for now).
- White-label multi-vendor marketplace.
- Client self-service billing and plan changes (unless product roadmap adds it).
