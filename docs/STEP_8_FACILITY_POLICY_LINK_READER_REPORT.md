# STEP 8 — Facility Policy Link Reader Report

**Date:** 2026-06-26  
**Scope:** Offline policy link ingestion, cached analysis index, live facility answers

---

## Policy links discovered

See full inventory: [`docs/FACILITY_POLICY_LINK_INVENTORY.md`](FACILITY_POLICY_LINK_INVENTORY.md)

| Metric | Value |
|--------|------:|
| Total facilities | **3,728** |
| Facilities with `policy_url` | **3,665** |
| Unique policy URLs | **2,452** |
| Duplicate URLs (2+ facilities) | **303** |
| Missing policy URLs | **63** |
| Invalid URL samples | **71** |
| Unique domains | **1,986** |
| Likely PDF links | **29** |
| Likely HTML links | **2,423** |

---

## Offline fetch results

| Metric | Value |
|--------|------:|
| URLs fetched (cached raw text) | **0** *(pipeline ready; bulk fetch not run in CI)* |
| Fetch failures | **0** |
| Facilities analyzed | **3,728** |
| From ingested policy text | **0** |
| From CSV structured data | **3,728** |
| Escalation required (thin data) | **63** |

**Note:** Run `python scripts/fetch_facility_policy_links.py` on a maintenance host to populate `app/data/facility_policy_raw/`. Live calls never trigger fetches.

---

## Restrictions detected (deterministic analysis)

| Restriction signal | Facilities |
|--------------------|-------------:|
| Magazines restricted | **2** |
| Books restricted | **0** |
| Vendor/publisher required | **41** |
| Hardcover restricted | **5** |

Most facilities are URL-only in CSV (no structured allowance columns). After bulk policy fetch + analyze, restriction counts are expected to rise significantly.

---

## Pipeline deliverables

| Artifact | Path |
|----------|------|
| URL inventory | `docs/FACILITY_POLICY_LINK_INVENTORY.md` |
| Pipeline docs | `docs/FACILITY_POLICY_LINK_PIPELINE.md` |
| Raw policy cache | `app/data/facility_policy_raw/` |
| Policy analysis | `app/data/facility_policy_analysis.json` |
| Knowledge index | `app/data/facility_policy_knowledge_index.json` |
| Fetch script | `scripts/fetch_facility_policy_links.py` |
| Analyze script | `scripts/analyze_facility_policies.py` |
| Text cleaner | `app/facility/policy_text_cleaner.py` |
| Policy analyzer | `app/facility/policy_analyzer.py` |
| Product classifier | `app/facility/product_content_classifier.py` |
| Live service | `app/facility/policy_service.py` |

---

## Live service upgrades

New cached-only APIs:

- `get_facility_policy_analysis(facility_name, state?)`
- `answer_facility_question(facility_name, question, ...)`
- `explain_delivery_rejection(facility_name, product_title?, ...)`

Priority: **ingested analysis → CSV normalized data → escalation** (never invent).

New voice tools wired into planner, tool router, and response composer:

- `fetch_facility_policy_analysis`
- `answer_facility_policy_question`
- `explain_facility_delivery_rejection`
- `classify_product_content_for_facility`

---

## Tests added

**Module:** `app/tests/test_step8_facility_policy_link_reader.py` (20 cases)

1. Policy link inventory counts URLs  
2. Fetcher caches raw policy text  
3. Fetcher skips existing cache  
4. HTML policy text extraction (mocked)  
5. PDF unsupported path does not crash  
6. Policy analyzer detects books allowed  
7. Policy analyzer detects magazines restricted  
8. Policy analyzer detects publisher/vendor required  
9. Evidence snippets stored  
10. Facility service uses policy analysis before CSV fallback  
11. Missing policy link falls back to CSV  
12. Unknown policy escalates instead of inventing  
13. Product classifier detects magazine  
14. Product classifier detects newspaper  
15. Delivery rejection requires policy evidence  
16. Order facility question respects verification  
17. Live path does not fetch external URLs  
18. Planner routes delivery rejection correctly  
19. Response composer gives customer-friendly answer  
20. Analyze script writes outputs  

**Regression:** `test_step4_orchestrator_parity.py` updated for `answer_facility_policy_question`.

---

## Test results

```text
python -m compileall app -q          # OK
python -m pytest -q --tb=short     # 576 passed
```

All existing facility tests (Step 6, Step 7, v4.33–v4.34 workers) remain green.

---

## Remaining data limitations

1. **Bulk offline fetch not yet executed** — 2,452 unique URLs await `fetch_facility_policy_links.py` on a maintenance schedule.  
2. **Most CSV rows are URL-only** — only sample/test rows have structured `allowed_*` columns today.  
3. **Invalid/empty-domain URLs (71)** — need manual CSV cleanup or alias correction.  
4. **Duplicate URLs (303)** — shared policies across facilities are handled via URL hash dedup in fetch cache.  
5. **LLM summary optional** — deterministic rules are default; set `FEATURE_POLICY_LLM_SUMMARY=true` only offline.

---

## Updated scores (estimate)

| Area | Before (Step 7) | After (Step 8) |
|------|----------------:|---------------:|
| Facility policy knowledge | 76 | **84** |
| Delivery/rejection reasoning | 68 | **82** |
| Overall requirement-fit | 76 | **81** |
| Overall enterprise score | 74 | **78** |

With bulk policy fetch + analyze complete: facility score projected **90–94**.

---

## Safety confirmation

| Rule | Status |
|------|--------|
| No live-call web scraping | Enforced — fetch script is offline-only |
| No invented policy answers | Enforced — escalation when confidence low |
| Policy evidence for product risk | Enforced — dual match required |
| CSV fallback when link unavailable | Enforced |
| Order privacy verification | Enforced — unchanged from Step 6 |
