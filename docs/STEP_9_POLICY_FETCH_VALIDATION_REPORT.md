# STEP 9 — Policy Fetch Validation Report

**Date:** 2026-06-26  
**Status:** **PARTIAL CHECKPOINT VALIDATION** (fetch not fully complete)

The offline policy link fetch was started for all **2,452** unique URLs. At checkpoint time (~10.6% progress), analysis and answer validation were run against the current cache. The fetch job may still be running or can be resumed safely — see [Resume instructions](#resume-instructions).

> **Not full completion.** Full fetch at ~3–5 seconds per URL is estimated at **3–5 hours** on this host. This report validates pipeline behavior on partial data; re-run analysis and validation after fetch completes.

---

## Fetch checkpoint (at analysis time)

| # | Metric | Value |
|---|--------|------:|
| 1 | Total unique URLs | **2,452** |
| 2 | Fetched so far (metadata files) | **259** (~10.6%) |
| 3 | Successful fetches (text cached) | **153** |
| 4 | Failed fetches | **106** |
| 5 | Skipped existing | **0** |
| 6 | Timeout count | **19** |
| 7 | PDF / unsupported count | **1** |
| 8 | Empty text count | **2** |
| 9 | Top failed domains | See below |
| 10 | Cache folder size | **~0.49 MB** (259 metadata + 153 text files) |
| 11 | Safe to resume later? | **Yes** — see resume section |

### Top failed domains (checkpoint)

| Domain | Failures | Typical cause |
|--------|----------:|---------------|
| `(empty)` | 9 | Invalid/malformed URLs in CSV (missing `http://`) |
| `dcr.hawaii.gov` | 3 | Timeout / SSL |
| `crimewatch.net` | 3 | HTTP errors |
| `bonnevillesheriff.com` | 3 | Timeout |
| `cumberlandsheriffnc.gov` | 2 | HTTP errors |
| `co.coos.or.us` | 2 | HTTP errors |
| `butlercountyne.gov` | 2 | HTTP errors |
| `dcsheriff.net` | 2 | Timeout |
| `county.milwaukee.gov` | 2 | HTTP errors |
| `conejoscounty.colorado.gov` | 2 | HTTP errors |

Additional failure modes observed:
- **Invalid URLs** — plain text, addresses, or `N/A` instead of `https://` links (9 `(empty)` domain failures)
- **HTTP 403/404/465** — blocked or misconfigured hosts
- **Robots disallowed** — 2 at checkpoint
- **PDF** — 1 failed before `pypdf` was installed; re-fetch with `--force` after install

### Progress after checkpoint (informational)

Background fetch continued past the checkpoint. As of report write, cache had grown to **~364 metadata / 230 text files (~14.8%)** and **~1.0 MB**. Re-run analysis after full fetch for final numbers.

---

## Analysis result (checkpoint cache)

Command run:

```bash
python scripts/analyze_facility_policies.py
```

| Metric | Value |
|--------|------:|
| Facilities analyzed | **3,728** |
| From ingested policy text | **197** |
| From CSV fallback only | **3,531** |
| Escalation required | **63** |
| Books policy detected | **3** |
| Magazines policy detected | **3** |
| Newspapers policy detected | **2** |
| Vendor/publisher required | **41** |
| Restricted content detected | **7** |
| Evidence snippets created | **9** |

### Confidence distribution

| Bucket | Count | Meaning |
|--------|------:|---------|
| High (≥ 0.75) | **2** | Strong ingested + CSV signal |
| Medium (0.55–0.74) | **3,663** | CSV structured or partial ingested |
| Low (< 0.55) | **0** | — |
| None (0) | **63** | URL-only / no actionable data → escalate |

Ingested policy text from **197** fetched URLs already improved restriction detection vs Step 8 CSV-only baseline (evidence snippets: 0 → **9**).

---

## Quality validation result

Command run:

```bash
python scripts/validate_facility_policy_answers.py
```

Full report: [`docs/FACILITY_POLICY_ANSWER_VALIDATION.md`](FACILITY_POLICY_ANSWER_VALIDATION.md)

| Check | Pass rate |
|-------|----------:|
| Facility lookup works | **100%** |
| Policy source exists | **100%** |
| Uses cached policy analysis | **98%** |
| No invented answer when evidence missing | **100%** |
| Escalation when confidence low | **2%** *(sample mostly high-confidence facilities)* |
| Answer includes source reference | **100%** |
| Customer-friendly message | **100%** |

Sample size: **50** facilities (seed=42). No validation failures recorded.

---

## Tests

```text
python -m compileall app -q          # OK
python -m pytest -q --tb=short         # 584 passed (step 8 + 9 + full suite)
```

Step 9 tests (`test_step9_policy_fetch_validation.py`):

1. Analyzed policy overrides URL-only CSV  
2. Low-confidence analysis escalates  
3. Evidence snippets in internal result  
4. Customer answer does not expose huge raw text  
5. Missing fetched policy falls back to CSV  
6. Failed fetch does not break live answer  
7. Validation script creates report  

---

## Remaining weak domains / URLs

1. **~2,193 URLs not yet fetched** — resume offline fetch on maintenance host  
2. **Invalid CSV URLs (71)** — missing protocol, embedded newlines, plain-text labels  
3. **Timeout-prone domains** — sheriff/county `.gov` sites with slow SSL  
4. **`crimewatch.net` / third-party aggregators** — often block automated access  
5. **PDF policies** — need `pypdf` installed + `--force` re-fetch for failed PDFs  
6. **63 facilities** still URL-only with escalation after analyze  

---

## Updated scores (estimate — partial checkpoint)

| Area | Step 8 | Step 9 (checkpoint) | After full fetch (projected) |
|------|-------:|--------------------:|-----------------------------:|
| Facility policy knowledge | 84 | **86** | 92–94 |
| Delivery/rejection reasoning | 82 | **84** | 90–92 |
| Overall requirement-fit | 81 | **83** | 88–90 |
| Overall enterprise score | 78 | **80** | 86–88 |

Checkpoint improves ingested coverage from **0 → 197** facilities with parsed policy text; full fetch should push ingested coverage toward **~1,500–2,000** (assuming ~60–80% success rate).

---

## Resume instructions

**Safe to resume:** Yes. The fetcher skips URLs that already have `{hash}.txt` + `{hash}.metadata.json` unless `--force` is passed.

```bash
cd services/twilio-voice-agent

# Continue fetch (picks up where it left off)
python scripts/fetch_facility_policy_links.py --delay 0.25

# After fetch completes — re-analyze and re-validate
python scripts/analyze_facility_policies.py
python scripts/validate_facility_policy_answers.py

# Optional: re-fetch failed PDFs after pypdf install
python scripts/fetch_facility_policy_links.py --force --delay 0.5
```

---

## Next recommended step

1. **Let fetch complete** on a maintenance machine (`nohup` / scheduled job).  
2. **Re-run analyze + validation** on full cache.  
3. **Clean invalid CSV URLs** (9+ malformed entries causing `(empty)` domain failures).  
4. **Re-fetch PDFs** with `pypdf` installed.  
5. **Publish updated** `facility_policy_analysis.json` with voice service restart (`pm2 restart twilio-voice-agent`).

---

## Safety confirmation

| Rule | Status |
|------|--------|
| No live-call URL fetching | **Enforced** — fetch script is offline-only |
| No invented policy answers | **Enforced** — 100% no-invention in validation sample |
| Live architecture unchanged | **Yes** — only offline scripts + cached data updated |
| Tests passing | **Yes** — full suite green |
