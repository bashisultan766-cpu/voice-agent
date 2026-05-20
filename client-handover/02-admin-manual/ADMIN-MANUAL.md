# Admin manual — AI Voice Agents platform

This manual describes how to operate the dashboard and daily tasks. Keep it handy for onboarding and support.

---

## 1. Platform login

- Open the dashboard URL provided by your administrator.
- Log in with your email and password.
- If you have multiple tenants, ensure you are in the correct organization (if the UI supports switching).

---

## 2. Dashboard overview

After login you see the main dashboard:

- **Overview:** High-level metrics (calls, resolution, escalation).
- **Stores:** Manage stores and Shopify connections.
- **Agents:** Create and edit voice agents.
- **Calls:** List of calls; open a call to see transcript and details.
- **Knowledge:** FAQs, branch profiles, documents (policies, etc.).
- **Analytics:** Charts and tables by agent, store, and tool.
- **QA review:** Queue of calls for review; submit scores and notes.
- **Settings:** User and tenant settings (as permitted by your role).

---

## 3. Managing stores

- **Add store:** Create a new store with name, slug, and contact info.
- **Edit store:** Update address, phone, email, timezone.
- **Connect Shopify:** Use the store’s integration page to connect a Shopify store (OAuth or token as per your setup). Ensure required scopes are granted.
- **Disconnect:** Disconnect Shopify when needed; the store profile remains. Reconnect when a new token is available.

---

## 4. Connecting Shopify

- Go to the store’s integration or settings.
- Start “Connect Shopify” and complete the authorization flow (or paste token if using custom app).
- After connection, the platform can use products and orders for that store.
- If the token expires or is revoked, reconnect using the same flow or paste a new token.

---

## 5. Managing phone numbers

- **List numbers:** View Twilio numbers linked to your tenant.
- **Assign to agent:** Assign a number to an agent so that calls to that number use that agent’s prompt and tools.
- **Unassign:** Remove assignment if the number is no longer used for that agent.

---

## 6. Creating agents

- **Create agent:** Choose a store; set name, description, and language.
- **Base prompt:** Write the system prompt that defines the agent’s role, tone, and rules.
- **Greeting / fallback / escalation:** Set the opening message, fallback when the agent cannot help, and escalation message.
- **Tools:** Enable the tools this agent may use (e.g. search_books, get_order_status, get_store_hours, search_store_faqs, get_return_policy).
- **Save as draft:** Test before publishing. Publish when ready for live calls.

---

## 7. Updating prompts

- Open the agent.
- Edit the base prompt (or create a new prompt version if your setup supports versioning).
- Save as draft. Use test scenarios or staging if available.
- **Publish** so the live agent uses the new prompt. Monitor calls and analytics for the next 24–48 hours.

---

## 8. Publishing prompt versions

- If the platform supports prompt versions: create a new version, edit content, then publish.
- Published version is used for all new calls. Keep previous versions for rollback if needed.

---

## 9. Managing FAQs and branch info

- **FAQs:** Add or edit question–answer pairs per store (and optionally per branch). Use clear, short answers for voice.
- **Branch profiles:** Add branch name, city, address, phone, opening hours (e.g. JSON or form). Agent uses this for “where are you?” and “what are your hours?”
- **Documents:** Upload or paste policy documents (return, shipping, etc.). Prefer a short “voice summary” for phone answers.

---

## 10. Uploading policies / documents

- Go to Knowledge → Documents (or store-specific knowledge).
- Create a document: choose type (e.g. return policy, shipping policy), store, and optionally branch.
- Paste or upload content. Add a short voice summary for best phone answers.
- Set status to Active when ready. If vector search is enabled, reindex so the agent can retrieve from long documents.

---

## 11. Viewing calls and transcripts

- **Calls:** Open the Calls list; filter by date, store, or agent.
- **Transcript:** Open a call to see the full transcript (user and agent turns).
- **Tool timeline:** See which tools were called and whether they succeeded or failed. Use this for debugging and QA.

---

## 12. Reviewing analytics

- **Overview:** Total calls, resolution rate, escalation rate, average duration, callback requests.
- **By agent:** Resolution and escalation rates, average duration, tool usage per agent.
- **By store:** Call volume and resolution per store.
- **By tool:** Success rate and latency per tool (e.g. get_order_status, search_store_faqs).

Use these to find weak agents, missing FAQs, or tools that need fixing.

---

## 13. Handling escalations

- Escalated calls appear in the call list (and optionally in a dedicated queue).
- Open the transcript to see why the user asked for a human or why the agent escalated.
- Follow your internal process: callback, ticket, or handoff. Use QA review to add notes and “needs prompt update” / “needs FAQ update” so content can be improved.

---

## 14. Common errors and fixes

| Issue | What to check |
|-------|----------------|
| Calls not answered | Twilio number and webhook URL; agent assigned to number; runtime health. |
| Wrong store info | Prompt and knowledge base for that store; branch profiles and FAQs. |
| Order lookup fails | Shopify connection and token; scopes; verification (order # + email/phone). |
| Too many escalations | Prompt clarity; missing FAQs or branch info; tool timeouts or failures. |
| “I don’t know” answers | Add or update FAQs and documents; check retrieval and tool success in analytics. |

For detailed incident steps, see the Support and Incident Runbooks.
