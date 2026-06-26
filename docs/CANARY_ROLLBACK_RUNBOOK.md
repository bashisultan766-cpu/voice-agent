# Canary Deploy & Rollback Runbook

**Service:** Twilio ConversationRelay Voice Agent  
**Date:** 2026-06-26

---

## 1. Deploy to staging

```bash
cd /var/www/voice-agent
git fetch origin && git checkout <release-tag>
cd services/twilio-voice-agent
.venv/bin/pip install -r requirements.txt

# Staging env
export APP_ENV=staging   # or development with staging secrets
export PUBLIC_BASE_URL=https://staging-agent.example.com

python scripts/pre_deploy_health_gate.py --quick-tests
python scripts/staging_smoke_tests.py
pm2 reload ecosystem.config.cjs --update-env
curl -sS https://staging-agent.example.com/health | jq .
```

Place 2–3 test calls. Verify orchestrator logs: `orchestrator_complete`, no `orchestrator_fallback`.

---

## 2. Canary in production

### Pre-canary

```bash
APP_ENV=production python scripts/pre_deploy_health_gate.py
python -m app.scripts.runtime_identity_check
```

### Deploy canary (single instance)

```bash
git pull origin <release-tag>
cd services/twilio-voice-agent && .venv/bin/pip install -r requirements.txt
pm2 reload twilio-voice-agent --update-env
```

### Enable orchestrator in canary

Ensure `.env` / PM2 env:

```env
VOICE_ORCHESTRATOR_ENABLED=true
VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true   # explicit
```

Reload: `pm2 reload twilio-voice-agent --update-env`

Route **10–20% traffic** only if you have multiple instances; with single instance, canary = time-boxed observation after deploy.

---

## 3. Metrics to watch (first 30–60 minutes)

| Metric | Source | Alert threshold |
|--------|--------|-----------------|
| Call failure rate | Twilio / app logs `ConversationRelay error` | > 2% of calls |
| Fallback runtime count | `call_metrics` / logs `legacy_fallback` | > 5% of calls |
| Average turn latency | `turn_latency` logs / `call_metrics` | > 5000 ms avg |
| Shopify failures | `tool_events` error_code, circuit open | > 10/min |
| Resend failures | `payment_email_send_result email_sent=false` | Any sustained |
| Payment link failures | `payment_auto_send_complete success=false` | > 2 per hour |
| Not-found escalations | `product_not_found_escalation` rate | Spike > 3x baseline |
| Facility unknown rate | facility tool `not_found` | Spike > 2x baseline |
| Order privacy blocks | `gate_tool_call` order blocked | Expected; spike = misconfig |
| Error rate | 5xx on `/health`, WS disconnect errors | Any sustained 5xx |

### Quick commands

```bash
# Health
curl -sS https://agent.example.com/health | jq '{ok, redis_status, orchestrator_enabled, runtime_identity_ok}'

# PM2
pm2 logs twilio-voice-agent --lines 100

# Analytics (staging/admin only)
curl -H "X-Admin-Key: $INTERNAL_ADMIN_KEY" \
  https://agent.example.com/admin/analytics/summary
```

---

## 4. Fallback runtime policy

- `VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED=true` — orchestrator crash → one-turn `llm_tool_runtime` recovery
- **Do not disable** during first production week
- Disable only after 7 days with `fallback_runtime_calls == 0` in analytics

---

## 5. When to rollback

Rollback immediately if:

- `/health` `ok: false` for > 2 minutes
- Payment links failing for confirmed-email test calls
- WS auth rejecting all connections (`ws_token_rejected` spike)
- `runtime_identity_check_failed` in logs
- Call failure rate > 5% for 10 minutes
- Shopify circuit open > 15 minutes

---

## 6. Exact rollback commands

```bash
cd /var/www/voice-agent
git log -1 --oneline                    # note bad commit
git checkout <previous-stable-tag>
cd services/twilio-voice-agent
.venv/bin/pip install -r requirements.txt
pm2 reload twilio-voice-agent --update-env
curl -sS http://127.0.0.1:8001/health | jq .
```

If PM2 broken:

```bash
pm2 stop twilio-voice-agent
pm2 start ecosystem.config.cjs
pm2 save
```

Nginx (if config changed):

```bash
sudo cp /etc/nginx/sites-available/voice-agent.conf.bak /etc/nginx/sites-available/voice-agent.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. Post-rollback validation

```bash
python scripts/staging_smoke_tests.py
curl -sS http://127.0.0.1:8001/health | jq .
# Place test call — confirm greeting + product search
# Confirm payment path still blocks without confirmed email
```

---

## 8. Incident checklist

- [ ] Confirm user impact (calls failing / degraded)
- [ ] Check `/health` and PM2 status
- [ ] Check Redis: `redis-cli ping`
- [ ] Check recent deploy: `git log -1`, `pm2 describe twilio-voice-agent`
- [ ] Rollback if within 15 min of deploy and metrics red
- [ ] Preserve logs: `pm2 logs twilio-voice-agent --lines 500 > /tmp/incident-$(date +%s).log`
- [ ] Notify stakeholders
- [ ] Post-incident: update `docs/CANARY_ROLLBACK_RUNBOOK.md` if new failure mode

---

## 9. Post-deploy daily report

```bash
cd services/twilio-voice-agent
python scripts/generate_daily_voice_agent_report.py
```

Review `docs/reports/YYYY-MM-DD_voice_agent_report.md`.
