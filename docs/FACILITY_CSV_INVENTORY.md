# Facility CSV Inventory

**Audit date:** 2026-06-26  
**Expected client deliverable:** ~51 facility/state policy CSV files  
**Files found in repository:** **2 unique CSV sources** (3 paths including duplicate mirror)

---

## Summary

| Metric | Value |
|--------|-------|
| CSV files discovered | **2** (`facility_guidelines.csv`, `facility_csv/sample_policies.csv`) |
| Legacy approved list | `facility_approved_list.csv` (derived/synced, not a policy source) |
| Total data rows ingested | **3** facilities after deduplication |
| Client files missing | **~48–49** (51 expected minus 2 present) |

**Status:** Infrastructure is ready; **client CSV bulk data is not in the repo.**

---

## File inventory

### 1. `services/twilio-voice-agent/app/data/facility_guidelines.csv`

| Field | Value |
|-------|-------|
| Path | `app/data/facility_guidelines.csv` |
| Row count | **1** data row (+ header) |
| Columns | `facility_name`, `city`, `state`, `approved`, `website_name`, `website_url`, `allowed_formats`, `disallowed_formats`, `disallowed_keywords`, `disallowed_categories`, `content_notes`, `aliases`, `source_pdf` |
| State field | `state` (TX) |
| Facility field | `facility_name` |
| Policy link | `website_url` |
| Content restrictions | `allowed_formats`, `disallowed_formats`, `disallowed_keywords`, `disallowed_categories`, `content_notes` |
| Parsing problems | None — example/placeholder row only |

### 2. `services/twilio-voice-agent/app/data/facility_csv/sample_policies.csv`

| Field | Value |
|-------|-------|
| Path | `app/data/facility_csv/sample_policies.csv` |
| Row count | **2** data rows (+ header) |
| Columns | `facility_name`, `state`, `city`, `allowed_books`, `allowed_magazines`, `allowed_newspapers`, `restricted_content`, `policy_summary`, `policy_url`, `aliases` |
| State field | `state` |
| Facility field | `facility_name` |
| Policy link | `policy_url` |
| Content restrictions | `allowed_books`, `allowed_magazines`, `allowed_newspapers`, `restricted_content` |
| Parsing problems | None — sample data for development/tests |

### 3. `services/twilio-voice-agent/app/data/facility_approved_list.csv`

| Field | Value |
|-------|-------|
| Path | `app/data/facility_approved_list.csv` |
| Row count | **1** data row (+ header) |
| Columns | `facility_name`, `city`, `state`, `approved`, `notes` |
| Purpose | Legacy approval list synced from guidelines ingest — **not** a full policy CSV |
| Parsing problems | Not used as primary policy ingest source |

---

## Drop folder for client files

Place client CSVs in:

```
services/twilio-voice-agent/app/data/facility_csv/
```

Then run:

```
python scripts/ingest_facility_csv_policies.py
```

---

## What is missing

The business requirement references **~51 CSV files** from the client. The repository currently contains:

- 1 legacy example row in `facility_guidelines.csv`
- 2 sample development rows in `facility_csv/sample_policies.csv`
- **No state-by-state bulk CSV pack**

Until the client files are added to `app/data/facility_csv/`, the agent can only answer policy questions for the **3 ingested example facilities**.

---

## Generated outputs (after ingest)

| Output | Path |
|--------|------|
| Normalized policies | `app/data/facility_policies_normalized.json` |
| Search index | `app/data/facility_policy_index.json` |

Ingest command log (2026-06-26):

```
Discovered 2 CSV file(s)
  loaded 1 row(s) from facility_guidelines.csv
  loaded 2 row(s) from sample_policies.csv
Wrote 3 facilities
```
