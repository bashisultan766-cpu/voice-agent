# STEP 13 — Production Deployment Maturity Report

**Date:** 2026-06-26  
**Scope:** Config audit, deploy gates, staging smoke tests, PM2/Nginx hardening, canary/rollback, multi-worker audit

---

## Production config findings

See [`docs/PRODUCTION_CONFIG_AUDIT.md`](PRODUCTION_CONFIG_AUDIT.md).

| Finding | Severity |
|---------|----------|
| `APP_ENV=development` default | High if undeployed |
| `DEBUG=true` skips `validate_production()` | Critical |
| Admin debug endpoints default off | ✅ Safe |
| API docs auto-disabled in production | ✅ Safe |
| `SUPPORT_EMAIL` required when escalation on | Validated |
| `REDIS_URL` required in production | Validated |
| Legacy fallback should be explicit in env | Gate warns |
| OTEL enabled without endpoint | Gate warns |

---

## Scripts added

| Script | Purpose |
|--------|---------|
| `scripts/pre_deploy_health_gate.py` | Pre-deploy checks; exit 1 on critical failure |
| `app/deploy/pre_deploy_gate.py` | Testable gate logic |
| `scripts/staging_smoke_tests.py` | Safe smoke tests (no live payment/email) |

### Pre-deploy gate checks

- Pytest (excludes live markers) or `--skip-tests` / `--quick-tests`
- Redis ping
- Postgres ping if `DATABASE_URL` set
- Shopify, OpenAI, Resend, Twilio, `SUPPORT_EMAIL`
- Orchestrator enabled
- Legacy fallback policy explicit
- API docs disabled in production
- Admin debug disabled unless `ALLOW_ADMIN_DEBUG_IN_PRODUCTION`
- `PUBLIC_BASE_URL` https, WS token validation

---

## Docs updated

| Document | Change |
|----------|--------|
| `docs/PRODUCTION_CONFIG_AUDIT.md` | **New** |
| `docs/MULTI_WORKER_SAFETY_AUDIT.md` | **New** |
| `docs/CANARY_ROLLBACK_RUNBOOK.md` | **New** |
| `docs/DEPLOYMENT.md` | Gate, rollback, env checklist, scaling |
| `ecosystem.config.cjs` | Memory limit, graceful reload, log rotation notes |
| `infra/nginx/voice-agent.mailcallcommunication.com.conf` | Health timeouts, sticky WS comment |
| `.env.example` | `ALLOW_ADMIN_DEBUG_IN_PRODUCTION` note |

**Unchanged:** payment safety, order privacy, facility safety, analytics, workflow replay, WS auth, rate limits, business logic.

---

## Tests added (9)

1. Pre-deploy gate fails when `REDIS_URL` missing in production  
2. Pre-deploy gate fails when `SUPPORT_EMAIL` missing  
3. Pre-deploy gate passes in test mode  
4. Staging smoke tests dry-run mode  
5. Health endpoint does not expose secrets  
6. Production docs disabled  
7. Admin debug disabled by default  
8. Canary runbook file exists  
9. Multi-worker audit file exists  

---

## Test results

```text
python -m compileall app -q          # OK
python -m pytest -q --tb=short     # 640 passed (full suite)
```

---

## Scaling recommendation

**Single PM2 instance + uvicorn `--workers 1`** per host.

Horizontal scale only with:
- Nginx `ip_hash` / ALB sticky sessions for WebSocket
- Shared Redis
- Acceptance of per-process Shopify circuit breaker

See [`docs/MULTI_WORKER_SAFETY_AUDIT.md`](MULTI_WORKER_SAFETY_AUDIT.md).

---

## Canary / rollback recommendation

1. Run `pre_deploy_health_gate.py` + `staging_smoke_tests.py` before every deploy  
2. `pm2 reload twilio-voice-agent --update-env` (not hard restart)  
3. Watch metrics for 30–60 min (see runbook)  
4. Rollback via `git checkout <tag>` + `pm2 reload`  
5. Daily `generate_daily_voice_agent_report.py` for trend review  

See [`docs/CANARY_ROLLBACK_RUNBOOK.md`](CANARY_ROLLBACK_RUNBOOK.md).

---

## Updated scores (estimate)

| Area | Step 12 | Step 13 |
|------|--------:|--------:|
| Production readiness | 88 | **93** |
| Enterprise / deploy maturity | 85 | **91** |
| Observability | 94 | **94** |
| Overall requirement-fit | 89 | **90** |

---

## Quick deploy checklist

```bash
cd services/twilio-voice-agent
APP_ENV=production python scripts/pre_deploy_health_gate.py
python scripts/staging_smoke_tests.py
pm2 reload twilio-voice-agent --update-env
curl -sS http://127.0.0.1:8001/health | jq .
```
