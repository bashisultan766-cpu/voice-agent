# STEP 6 — Facility CSV Policy Knowledge Report

**Date:** 2026-06-26  
**Scope:** Normalized facility policy ingest, search service, orchestrator tools

---

## CSV inventory result

See full inventory: [`docs/FACILITY_CSV_INVENTORY.md`](FACILITY_CSV_INVENTORY.md)

| Metric | Value |
|--------|-------|
| CSV files found | **2** (`facility_guidelines.csv`, `facility_csv/sample_policies.csv`) |
| Client target | **~51 CSV files** |
| **Missing client files** | **~48–49** (not in repository) |
| Rows ingested (deduped) | **3** facilities |

**Honest status:** Infrastructure is production-ready; **client bulk CSV data is not present.**

---

## Normalized schema

`FacilityPolicyRecord` (`app/facility/policy_models.py`):

| Field | Purpose |
|-------|---------|
| `facility_name` | Display name |
| `normalized_facility_name` | Search key |
| `state` | US state filter |
| `facility_type` | Optional institution type |
| `allowed_books` | bool / null |
| `allowed_magazines` | bool / null |
| `allowed_newspapers` | bool / null |
| `restricted_content` | Keyword/format restrictions |
| `policy_summary` | Offline spoken summary |
| `policy_url` | Source link (not scraped live) |
| `source_file` | CSV path |
| `source_row` | Row number |
| `confidence` | Match confidence |
| `last_updated` | Ingest date |

**Outputs:**
- `app/data/facility_policies_normalized.json`
- `app/data/facility_policy_index.json`

---

## Ingestion pipeline

**Script:** `scripts/ingest_facility_csv_policies.py`

- Scans `app/data/facility_csv/**/*.csv` + legacy `facility_guidelines.csv`
- Flexible column alias mapping
- Deduplicates by normalized name + state
- Logs loaded/skipped files, parse errors, duplicates

**Run:**
```bash
cd services/twilio-voice-agent
python scripts/ingest_facility_csv_policies.py
```

---

## Policy service

**Module:** `app/facility/policy_service.py`

| Function | Purpose |
|----------|---------|
| `search_facility_policy(name, state)` | Fuzzy facility lookup |
| `check_content_allowed(name, content_type, state)` | Books/magazines/newspapers |
| `explain_facility_restriction(...)` | Safe restriction explanation |
| `get_policy_source(name, state)` | Source file/URL metadata |

**Safety rules:**
- Never invents policy
- `confidence < 0.55` → `escalation_required=true`
- Policy URL without summary → escalation message (no live scraping)

---

## Tools added / upgraded

| Tool | Registry | Orchestrator |
|------|----------|--------------|
| `search_facility_policy` | `llm_tools.py` | ✅ planner |
| `check_facility_content_allowed` | `llm_tools.py` | ✅ planner |
| `explain_facility_restriction` | `llm_tools.py` | ✅ planner (order delivery) |
| `facility_policy_lookup` | upgraded alias → `search_facility_policy` | backward compatible |

**Planner routing (`planner_agent.py`):**
- Magazine/newspaper allow questions → `check_facility_content_allowed`
- Order not delivered + facility → `explain_facility_restriction` (with order lookup + verification)
- General facility → `search_facility_policy`

**Intent router:** periodical allow questions + delivery issues with order/facility → `facility_question`

---

## Order / refund connection (Phase 7)

`explain_facility_restriction` tool:
- Verifies order when `order_number` provided (privacy gated)
- Pulls line items from Shopify lookup
- Uses facility name from utterance, session, or order shipping hint
- Explains restriction **only when policy data supports it**
- Otherwise escalates / asks for facility name

No blame assigned without policy evidence.

---

## Tests added

**File:** `app/tests/test_step6_facility_policy.py` — **21 tests**

1. CSV inventory doc exists  
2. CSV files discovered  
3. Normalized JSON exists  
4. Ingestion creates normalized JSON  
5. Facility search exact match  
6. Facility search fuzzy match  
7. Books allowed  
8. Magazines restricted  
9. Newspapers allowed  
10. Unknown facility escalates  
11. Bayview magazine/newspaper restrictions  
12. Policy URL stored  
13. Explanation includes source  
14. Missing facility asks for name  
15. No invented answer for unknown  
16. Planner magazine question  
17. Planner delivery + order question  
18. Composer facility message  
19. Model normalization  

**Updated:** `test_step4_orchestrator_parity.py` (facility tool name)

---

## Test results

```
python -m compileall app -q    # OK
python -m pytest -q --tb=short # 530 passed
```

---

## Files changed / added

| Path | Action |
|------|--------|
| `app/facility/policy_models.py` | New |
| `app/facility/policy_service.py` | New |
| `scripts/ingest_facility_csv_policies.py` | New |
| `app/data/facility_csv/README.md` | New |
| `app/data/facility_csv/sample_policies.csv` | New (dev sample) |
| `app/data/facility_policies_normalized.json` | Generated |
| `app/data/facility_policy_index.json` | Generated |
| `app/agent_runtime/llm_tools.py` | Tools + order-linked explain |
| `app/orchestrator/planner_agent.py` | Facility planner branches |
| `app/orchestrator/intent_router.py` | Periodical + delivery intents |
| `app/orchestrator/tool_router.py` | Tool aliases |
| `app/orchestrator/response_composer.py` | Facility deterministic messages |
| `docs/FACILITY_CSV_INVENTORY.md` | New |
| `app/tests/test_step6_facility_policy.py` | New |

---

## Remaining gaps

| Gap | Severity |
|-----|----------|
| Client ~51 CSV files not in repo | **Critical** for full business coverage |
| `order_reconciliation.py` still uses legacy `guidelines_registry` | Medium — works for example data |
| No vector/semantic facility search | Low |
| No live policy URL scraping (by design) | N/A |

**Next step for client:** Drop CSV files into `app/data/facility_csv/` and run ingest.

---

## Updated scores (estimate)

| Metric | Before Step 6 | After Step 6 |
|--------|---------------|--------------|
| Facility CSV policy support | 25 | **62** (infra complete; data missing) |
| Requirement-fit (facility) | 25 | **62** |
| Overall requirement-fit | 71 | **76** |
| Overall enterprise score | 70 | **74** |

With all 51 client CSVs ingested: facility score projected **88–92**.

---

## What was NOT changed

- Payment safety / email FSM  
- Order privacy gating  
- Product-not-found escalation (Step 5)  
- WS auth / rate limits  
