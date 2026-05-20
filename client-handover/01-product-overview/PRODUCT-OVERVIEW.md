# Product overview — AI Voice Agents for Bookstores

## What the system does

This platform is a **multi-tenant SaaS** that powers **AI voice agents** for Shopify-connected bookstores. When a customer calls a store’s Twilio number, the call is answered by an AI agent that can:

- Answer questions about **products, orders, store hours, branches, and policies**
- Use **Shopify** for products and orders (when connected)
- Use a **knowledge base** (FAQs, branch profiles, policy documents) for consistent, brand-aligned answers
- **Escalate** to a human or create a **callback request** when needed

## Who it is for

- **Store owners / operations:** Manage stores, agents, phone numbers, and content (prompts, FAQs, policies).
- **Support / QA:** Review calls, transcripts, and analytics; improve prompts and knowledge.
- **End customers:** Call the store and get instant, consistent answers 24/7.

## Main modules

| Module | Purpose |
|--------|---------|
| **Stores** | Store profile; Shopify connection; branch and contact info. |
| **Agents** | Voice agent config: prompt, greeting, tools, fallback, escalation. |
| **Phone numbers** | Twilio numbers; assignment to agents. |
| **Knowledge base** | FAQs, branch profiles, policy documents; used for RAG and fast answers. |
| **Calls** | Call list; transcripts; tool usage. |
| **Analytics** | Resolution rate, escalation rate, tool health, per-agent and per-store metrics. |
| **QA review** | Review transcripts; submit scores; flag prompt/FAQ updates. |

## Supported workflows

- **Inbound voice:** Customer calls → Twilio → platform → OpenAI realtime + tools → spoken response.
- **Order lookup:** Agent uses order number + verification (email/phone) → Shopify order status.
- **Product / inventory:** Agent searches products and checks availability (when Shopify connected).
- **Policies and FAQs:** Agent answers from knowledge base (FAQs, branch hours, return/shipping policy).
- **Escalation:** Agent triggers handoff or callback; support team follows up.

## Limitations (current version)

- Voice only (no WhatsApp/chat in v1).
- Single language per agent (multilingual in roadmap).
- Shopify and Twilio are required for full product/order and voice flows.
- Prompt and knowledge updates are manual (no A/B testing or auto-optimization in v1).

## Dependencies

- **Twilio:** Inbound voice; phone numbers; webhooks.
- **OpenAI:** Realtime API; tool calling; embeddings for knowledge (if vector store enabled).
- **Shopify:** Store connection; products and orders (when configured).
- **PostgreSQL:** Primary database for tenants, stores, agents, calls, knowledge, analytics.

For full technical and deployment details, see the Technical Handover document.
