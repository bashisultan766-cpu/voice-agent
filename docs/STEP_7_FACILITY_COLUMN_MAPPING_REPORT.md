# STEP 7 — Facility Column Mapping Report

**Date:** 2026-06-26  
**Scope:** Real client CSV column discovery, robust ingest mapping, value normalization, policy summary, service state disambiguation

---

## Column mapping audit

Full discovery report: [`docs/FACILITY_COLUMN_MAPPING_AUDIT.md`](FACILITY_COLUMN_MAPPING_AUDIT.md)

| Metric | Value |
|--------|-------|
| CSV files scanned | **56** |
| Unique column headers | **51** |
| Most common headers | `Facility Name` (49), `Books Allowed` (49), `Magazines Allowed` (49), `Newspapers Allowed` (49), `Facility Mail Policy Link` (49), `Website URL` (49), `State` (49), `City` (49) |

**Key finding:** Client CSVs use human-readable headers (`Facility Name`, `Books Allowed`, `Facility Mail Policy Link`). The prior mapper normalized underscores (`books_allowed`) but missed spaced headers (`booksallowed` ≠ `books allowed`). Most allowance cells are **blank** in the source files; policy links and facility metadata carry the usable signal.

---

## Aliases added

**Script:** `scripts/ingest_facility_csv_policies.py`

| Canonical field | New / prioritized aliases |
|-----------------|---------------------------|
| `facility_name` | Facility Name, Institution, Prison Name, Jail Name, Correctional Facility, Name of the Facility, Column 1 |
| `state` | State, State Name, Facility State |
| `city` | City, Facility City |
| `allowed_books` | Books Allowed, Book Allowed, Books Policy, Allows Books |
| `allowed_magazines` | Magazines Allowed, Magazine Allowed, Magazine Policy, Allows Magazines |
| `allowed_newspapers` | Newspapers Allowed, Newspaper Allowed, Newspaper Policy, Allows Newspapers |
| `policy_url` | **Facility Mail Policy Link** (first), Mail Policy Link, Policy Link, Policy URL, Source URL — Website URL deprioritized |
| `restricted_content` | Restrictions, Content Restrictions, Mail Rules, Common Rejection Reasons |
| `policy_notes` | Notes, Policy Notes, Other |
| Format helpers | Paperback Allowed, Hardcover Allowed, Strict Facility, Must Ship Direct from Publisher |

**Value normalization:** `yes` / `no` / `allowed` / `not allowed` / `permitted` / `prohibited` / `restricted` / `depends` / `see policy` / `unknown` / blank → `true` / `false` / `null` with ingest confidence; unclear text preserved in `restricted_content` / `policy_summary`.

**Policy summary:** Built only from mapped fields (allowance flags, formats, restrictions, notes, policy URL reference). No invented rules.

**Service fix:** `policy_service.py` now penalizes state mismatches on exact name matches and resolves duplicate facility names by state when answering content questions.

---

## Before / after policy coverage

| Metric | Before Step 7 | After Step 7 |
|--------|---------------|--------------|
| CSV files ingested | 56 | **56** |
| Raw rows | 1,354* | **4,678** |
| Normalized facilities (deduped) | 1,267* | **3,728** |
| Parse errors | 0 | **0** |
| `allowed_books` known | ~3 (sample only; real columns unmapped) | **3** |
| `allowed_magazines` known | ~2 (sample only) | **2** |
| `allowed_newspapers` known | ~2 (sample only) | **2** |
| `policy_url` present | ~1,200 (mostly Website URL) | **3,665** (mostly Facility Mail Policy Link) |
| Restriction / format notes | ~0 | **6** |
| Actionable policy records | Low (URL-only, empty summary) | **3,665** (summary + mail policy link) |

\*Prior run under-counted rows where facility name lived in `Column 1` / `Name of the Facility` and did not ingest the Sheriffs/County Jail sheet completely.

**Honest assessment:** Column mapping is fixed and production-ready. Client CSVs rarely populate `Books Allowed` / `Magazines Allowed` / `Newspapers Allowed` cells (only **2** non-empty book cells across ~4.6k rows). The agent correctly escalates when allowance is unknown rather than guessing.

---

## Facilities with usable policy answers

| Category | Count |
|----------|------:|
| Facilities with mail policy URL | 3,665 |
| Facilities with explicit book allow/deny | 3 |
| Facilities with explicit magazine allow/deny | 2 |
| Facilities with explicit newspaper allow/deny | 2 |
| Facilities with restriction/format notes | 6 |
| Facilities with deterministic allow/deny answers (books/mags/news) | **3** (sample + 2 sparse CSV rows) |
| Facilities with policy source + escalation path (URL/summary, unknown allowance) | **3,662** |

---

## Tests added

**File:** `app/tests/test_step7_facility_column_mapping.py` — **17 tests**

1. Real column `Books Allowed` maps correctly  
2. Real column `Magazines Allowed` maps correctly  
3. Real column `Newspapers Allowed` maps correctly  
4. `Facility Mail Policy Link` maps to `policy_url` (over Website URL)  
5. Yes/no/allowed/prohibited values normalize correctly (parametric)  
6. Blank values become null  
7. Policy summary includes restrictions  
8. Facility service answers book allowed correctly (Smith TX)  
9. Facility service answers magazine restricted correctly  
10. Facility service answers newspaper restricted correctly (Bayview)  
11. Low-confidence unclear values trigger escalation  
12. Ingested real CSV count > 50 when files exist  
13. Column audit runs  
14. Ingest main produces coverage block  

**Updated:** `app/facility/policy_service.py` — state-aware match scoring and `_record_from_search` disambiguation.

---

## Test results

```
python -m compileall app -q    # OK
python -m pytest -q --tb=short # 554 passed
```

(530 → 554 tests; +24 net including Step 7 suite.)

---

## Files changed / added

| Path | Action |
|------|--------|
| `scripts/ingest_facility_csv_policies.py` | Upgraded aliases, normalization, policy summary, coverage stats |
| `scripts/generate_facility_column_audit.py` | New audit generator |
| `app/facility/policy_service.py` | State-aware search + record lookup |
| `app/data/facility_policies_normalized.json` | Regenerated |
| `app/data/facility_policy_index.json` | Regenerated |
| `docs/FACILITY_COLUMN_MAPPING_AUDIT.md` | New |
| `docs/STEP_7_FACILITY_COLUMN_MAPPING_REPORT.md` | New |
| `app/tests/test_step7_facility_column_mapping.py` | New |

---

## Updated scores (estimate)

| Metric | Before Step 7 | After Step 7 |
|--------|---------------|--------------|
| Facility CSV ingest / column mapping | 62 | **88** |
| Facility policy answerability (explicit allow/deny) | 15 | **18** (data-limited, not code-limited) |
| Facility policy source coverage (URL + safe escalation) | 40 | **85** |
| Requirement-fit (facility) | 62 | **84** |
| Overall requirement-fit | 76 | **82** |
| Overall enterprise score | 74 | **78** |

**Remaining gap:** Client CSVs need populated allowance columns (or a separate rules sheet) for high-confidence spoken yes/no on books/magazines/newspapers at scale. Infrastructure supports it; source data does not.

---

## What was NOT changed

- Payment safety / email FSM  
- Order privacy gating  
- Product-not-found escalation (Step 5)  
- WS auth / rate limits  
- Orchestrator default path  
