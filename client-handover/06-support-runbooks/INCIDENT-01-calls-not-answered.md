# Incident 1 — Incoming calls not answered

**Symptom:** Customers call the store number but the call is not answered by the AI agent (e.g. timeout, error, or wrong message).

---

## Checks (in order)

1. **Twilio number config:** In Twilio console, confirm the number’s voice webhook URL is correct and points to your API (e.g. `https://api.example.com/api/twilio/voice/inbound`). Fix URL if wrong.
2. **Webhook route:** Confirm API is up and route is reachable (e.g. `curl` or health check). Check for deploy or DNS issues.
3. **Agent mapping:** Confirm the number is assigned to an agent in the platform; confirm that agent is published and active.
4. **Runtime health:** Check API logs for errors when Twilio sends the webhook (e.g. 5xx, timeout). Check database and external service (OpenAI) connectivity.
5. **OpenAI session init:** If logs show webhook received but no answer, check OpenAI API key and session creation; check for rate limits or init failures.
6. **Fallback logs:** If a fallback message is played, check why (e.g. agent not found, runtime error); fix config or code and retest.

---

## Resolution

- Correct webhook URL, agent assignment, or prompt/agent status; retest with a real call.
- If API or OpenAI is down, follow your outage process; inform client and use status page or callback if available.
- Document root cause and any change made; update runbook if a new check is needed.
