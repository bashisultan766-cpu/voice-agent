#!/usr/bin/env python3
"""
Ingest facility CSV policy files into normalized JSON for the voice agent.

Usage (from services/twilio-voice-agent):
  python scripts/ingest_facility_csv_policies.py

Input directories:
  app/data/facility_csv/**/*.csv     — client facility CSV drop folder
  app/data/facility_guidelines.csv   — legacy single-sheet export

Output:
  app/data/facility_policies_normalized.json
  app/data/facility_policy_index.json
"""
from __future__ import annotations

import csv
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "app" / "data"
CSV_DROP_DIR = DATA / "facility_csv"
LEGACY_CSV = DATA / "facility_guidelines.csv"
NORMALIZED_JSON = DATA / "facility_policies_normalized.json"
INDEX_JSON = DATA / "facility_policy_index.json"

# Ensure app package importable when run as script
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.facility.policy_models import FacilityPolicyRecord, normalize_facility_name  # noqa: E402

# Ordered aliases — first header match wins for each canonical field.
COLUMN_ALIASES: dict[str, list[str]] = {
    "facility_name": [
        "facility name",
        "facility",
        "institution",
        "prison name",
        "jail name",
        "correctional facility",
        "name of the facility",
        "facility_name",
        "name",
        "prison",
        "jail",
        "column 1",
    ],
    "state": [
        "state",
        "state name",
        "facility state",
        "st",
        "state_code",
        "state abbreviation",
    ],
    "city": [
        "city",
        "facility city",
        "town",
    ],
    "facility_type": [
        "facility type",
        "facility_type",
        "type",
        "institution_type",
    ],
    "allowed_books": [
        "books allowed",
        "book allowed",
        "books",
        "books policy",
        "allows books",
        "allowed_books",
        "books_allowed",
        "allow_books",
        "book_allowed",
    ],
    "allowed_magazines": [
        "magazines allowed",
        "magazine allowed",
        "magazines",
        "magazine policy",
        "allows magazines",
        "allowed_magazines",
        "magazines_allowed",
        "allow_magazines",
    ],
    "allowed_newspapers": [
        "newspapers allowed",
        "newspaper allowed",
        "newspapers",
        "newspaper policy",
        "allows newspapers",
        "allowed_newspapers",
        "newspapers_allowed",
        "allow_newspapers",
    ],
    "restricted_content": [
        "restrictions",
        "content restrictions",
        "mail rules",
        "common rejection reasons",
        "restricted_content",
        "disallowed_keywords",
        "disallowed_content",
    ],
    "policy_notes": [
        "notes",
        "policy notes",
        "policy_summary",
        "content_notes",
        "summary",
        "policy",
        "rules",
        "other",
    ],
    "policy_url": [
        "facility mail policy link",
        "mail policy link",
        "policy link",
        "policy url",
        "source url",
        "policy_url",
        "website url",
        "website",
        "url",
        "link",
    ],
    "paperback_allowed": [
        "paperback allowed",
        "paperback",
    ],
    "hardcover_allowed": [
        "hardcover allowed",
        "hardcover",
    ],
    "allowed_formats": [
        "allowed_formats",
        "allowed formats",
        "formats_allowed",
    ],
    "disallowed_formats": [
        "disallowed_formats",
        "disallowed formats",
    ],
    "aliases": [
        "aliases",
        "aka",
        "alternate_names",
    ],
    "approved": [
        "approved",
        "sureshot_approved",
    ],
    "strict_facility": [
        "strict facility",
    ],
    "must_ship_direct": [
        "must ship direct from publisher",
    ],
}

# Canonical fields used for column audit documentation.
AUDIT_FIELD_GROUPS: dict[str, list[str]] = {
    "facility_name": COLUMN_ALIASES["facility_name"],
    "books_allowed": COLUMN_ALIASES["allowed_books"],
    "magazines_allowed": COLUMN_ALIASES["allowed_magazines"],
    "newspapers_allowed": COLUMN_ALIASES["allowed_newspapers"],
    "policy_url": COLUMN_ALIASES["policy_url"],
    "restrictions": COLUMN_ALIASES["restricted_content"] + COLUMN_ALIASES["policy_notes"],
}


def _norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (h or "").lower())


def _map_row(row: dict[str, str]) -> dict[str, str]:
    """Map CSV headers to canonical fields; first alias match wins per field."""
    mapped: dict[str, str] = {}
    header_map = {_norm_header(k): k for k in row.keys()}
    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            key = header_map.get(_norm_header(alias))
            if key is None:
                continue
            val = (row.get(key) or "").strip()
            if val:
                mapped[canonical] = val
                break
    return mapped


def _split_list(val: str) -> list[str]:
    if not val:
        return []
    return [x.strip().lower() for x in re.split(r"[,;|]", val) if x.strip()]


def _split_aliases(val: str) -> list[str]:
    if not val:
        return []
    return [x.strip() for x in re.split(r"[,;|]", val) if x.strip()]


class AllowanceParse:
    __slots__ = ("value", "confidence", "note")

    def __init__(
        self,
        value: bool | None,
        confidence: float,
        note: str = "",
    ) -> None:
        self.value = value
        self.confidence = confidence
        self.note = note


def _parse_allowance(val: str) -> AllowanceParse:
    """Normalize yes/no/allowed/prohibited/unclear allowance values."""
    if val is None:
        return AllowanceParse(None, 1.0)
    raw = str(val).strip()
    if not raw:
        return AllowanceParse(None, 1.0)

    s = raw.lower()
    s = re.sub(r"\s+", " ", s)

    if s in ("yes", "y", "true", "1", "allowed", "permitted", "allow"):
        return AllowanceParse(True, 0.95)

    if s in ("no", "n", "false", "0", "prohibited", "banned", "denied"):
        return AllowanceParse(False, 0.95)

    if s in ("not allowed", "not permitted"):
        return AllowanceParse(False, 0.9)

    if s in ("restricted",):
        return AllowanceParse(False, 0.75, raw)

    if s in ("depends", "see policy", "unknown", "tbd", "varies", "contact", "call"):
        return AllowanceParse(None, 0.45, raw)

    if s.startswith("no ") and any(w in s for w in ("book", "hardcover", "spiral", "magazine", "newspaper")):
        return AllowanceParse(None, 0.55, raw)

    if "not allowed" in s or "not permitted" in s or "prohibited" in s:
        return AllowanceParse(False, 0.8, raw)

    if "allowed" in s or "permitted" in s:
        return AllowanceParse(True, 0.7, raw)

    return AllowanceParse(None, 0.5, raw)


def _parse_bool(val: str) -> bool | None:
    return _parse_allowance(val).value


def _merge_restrictions(*parts: str) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for part in parts:
        for item in _split_list(part):
            if item not in seen:
                seen.add(item)
                items.append(item)
        text = (part or "").strip()
        if text and not re.search(r"[,;|]", text):
            key = text.lower()
            if key not in seen and len(key) > 2:
                seen.add(key)
                items.append(key)
    return items


def _apply_format_allowance(
    label: str,
    raw: str,
    record: FacilityPolicyRecord,
    *,
    confidence_scores: list[float],
) -> None:
    parsed = _parse_allowance(raw)
    confidence_scores.append(parsed.confidence)
    fmt = label.lower()
    if parsed.value is True:
        if fmt not in record.allowed_formats:
            record.allowed_formats.append(fmt)
    elif parsed.value is False:
        if fmt not in record.disallowed_formats:
            record.disallowed_formats.append(fmt)
    elif parsed.note:
        if parsed.note.lower() not in record.restricted_content:
            record.restricted_content.append(parsed.note.lower())


def _build_policy_summary(record: FacilityPolicyRecord, extra_notes: list[str]) -> str:
    """Compose policy summary from known fields only — never invent policy."""
    parts: list[str] = []

    if record.allowed_books is True:
        parts.append("Books allowed.")
    elif record.allowed_books is False:
        parts.append("Books restricted.")

    if record.allowed_magazines is True:
        parts.append("Magazines allowed.")
    elif record.allowed_magazines is False:
        parts.append("Magazines restricted.")

    if record.allowed_newspapers is True:
        parts.append("Newspapers allowed.")
    elif record.allowed_newspapers is False:
        parts.append("Newspapers restricted.")

    if record.allowed_formats:
        parts.append(f"Allowed formats: {', '.join(record.allowed_formats)}.")
    if record.disallowed_formats:
        parts.append(f"Disallowed formats: {', '.join(record.disallowed_formats)}.")
    if record.restricted_content:
        parts.append(f"Restrictions: {', '.join(record.restricted_content[:8])}.")

    for note in extra_notes:
        text = (note or "").strip()
        if text and text not in parts:
            parts.append(text)

    if record.policy_url:
        parts.append(f"Policy reference: {record.policy_url}")

    return " ".join(parts).strip()


def _infer_content_permissions(
    mapped: dict[str, str],
    record: FacilityPolicyRecord,
) -> float:
    """Populate allowance fields; return aggregate ingest confidence."""
    confidence_scores: list[float] = []

    for field, key in (
        ("allowed_books", "allowed_books"),
        ("allowed_magazines", "allowed_magazines"),
        ("allowed_newspapers", "allowed_newspapers"),
    ):
        raw = mapped.get(key, "")
        parsed = _parse_allowance(raw)
        setattr(record, field, parsed.value)
        if raw.strip():
            confidence_scores.append(parsed.confidence)
            if parsed.note and parsed.note.lower() not in record.restricted_content:
                record.restricted_content.append(parsed.note.lower())

    approved = _parse_allowance(mapped.get("approved", ""))
    if approved.value is False:
        record.allowed_books = False
        record.allowed_magazines = False
        record.allowed_newspapers = False
        confidence_scores.append(approved.confidence)
    elif approved.value is True and record.allowed_books is None:
        record.allowed_books = True
        confidence_scores.append(approved.confidence)

    if mapped.get("paperback_allowed"):
        _apply_format_allowance(
            "paperback", mapped["paperback_allowed"], record, confidence_scores=confidence_scores
        )
    if mapped.get("hardcover_allowed"):
        _apply_format_allowance(
            "hardcover", mapped["hardcover_allowed"], record, confidence_scores=confidence_scores
        )

    if record.allowed_books is None and record.allowed_formats:
        if any(f in record.allowed_formats for f in ("paperback", "softcover", "book")):
            record.allowed_books = True
            confidence_scores.append(0.7)

    restricted = _merge_restrictions(
        mapped.get("restricted_content", ""),
        mapped.get("policy_notes", ""),
    )
    for item in restricted:
        if item not in record.restricted_content:
            record.restricted_content.append(item)

    if mapped.get("strict_facility"):
        strict = _parse_allowance(mapped["strict_facility"])
        if strict.note or mapped["strict_facility"].strip():
            note = (strict.note or mapped["strict_facility"]).strip()
            if note.lower() not in record.restricted_content:
                record.restricted_content.append(note.lower())
        confidence_scores.append(strict.confidence)

    if mapped.get("must_ship_direct"):
        note = mapped["must_ship_direct"].strip()
        if note.lower() not in record.restricted_content:
            record.restricted_content.append(note.lower())

    lower_summary = (record.policy_summary or "").lower()
    if record.allowed_magazines is None:
        if "no magazine" in lower_summary or "magazines not" in lower_summary or "magazines restricted" in lower_summary:
            record.allowed_magazines = False
        elif "magazine" in lower_summary and "allow" in lower_summary:
            record.allowed_magazines = True
    if record.allowed_newspapers is None:
        if "no newspaper" in lower_summary or "newspapers not" in lower_summary or "newspapers restricted" in lower_summary:
            record.allowed_newspapers = False
        elif "newspaper" in lower_summary and "allow" in lower_summary:
            record.allowed_newspapers = True

    if not confidence_scores:
        return 1.0
    return round(min(confidence_scores), 3)


def _row_to_record(
    mapped: dict[str, str],
    *,
    source_file: str,
    source_row: int,
) -> FacilityPolicyRecord | None:
    name = (mapped.get("facility_name") or "").strip()
    if not name:
        return None

    extra_notes: list[str] = []
    if mapped.get("policy_notes"):
        extra_notes.append(mapped["policy_notes"].strip())

    record = FacilityPolicyRecord(
        facility_name=name,
        state=(mapped.get("state") or "").strip().upper(),
        city=(mapped.get("city") or "").strip(),
        facility_type=(mapped.get("facility_type") or "").strip(),
        policy_summary="",
        policy_url=(mapped.get("policy_url") or "").strip(),
        source_file=source_file,
        source_row=source_row,
        last_updated=str(date.today()),
        aliases=_split_aliases(mapped.get("aliases", "")),
        allowed_formats=_split_list(mapped.get("allowed_formats", "")),
        disallowed_formats=_split_list(mapped.get("disallowed_formats", "")),
        disallowed_keywords=_split_list(mapped.get("restricted_content", "")),
    )

    ingest_confidence = _infer_content_permissions(mapped, record)
    record.confidence = ingest_confidence
    record.policy_summary = _build_policy_summary(record, extra_notes)
    return record


def discover_csv_files() -> list[Path]:
    files: list[Path] = []
    if LEGACY_CSV.exists():
        files.append(LEGACY_CSV)
    if CSV_DROP_DIR.exists():
        files.extend(sorted(CSV_DROP_DIR.rglob("*.csv")))
    return files


def load_csv_file(path: Path) -> tuple[list[FacilityPolicyRecord], list[str]]:
    records: list[FacilityPolicyRecord] = []
    errors: list[str] = []
    rel = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)

    try:
        with open(path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                errors.append(f"{rel}: missing header row")
                return records, errors
            for i, row in enumerate(reader, start=2):
                try:
                    mapped = _map_row(row)
                    rec = _row_to_record(mapped, source_file=rel, source_row=i)
                    if rec:
                        records.append(rec)
                except Exception as exc:
                    errors.append(f"{rel} row {i}: {type(exc).__name__}")
    except Exception as exc:
        errors.append(f"{rel}: {type(exc).__name__}: {exc}")

    return records, errors


def deduplicate_records(records: list[FacilityPolicyRecord]) -> tuple[list[FacilityPolicyRecord], list[str]]:
    """Merge duplicate facilities; prefer richer records."""
    by_key: dict[str, FacilityPolicyRecord] = {}
    duplicates: list[str] = []

    def richness(r: FacilityPolicyRecord) -> int:
        score = 0
        if r.policy_summary:
            score += 3
        if r.policy_url:
            score += 2
        if r.allowed_books is not None:
            score += 2
        if r.allowed_magazines is not None:
            score += 2
        if r.allowed_newspapers is not None:
            score += 2
        score += len(r.restricted_content)
        score += len(r.disallowed_formats)
        return score

    for rec in records:
        key = f"{rec.normalized_facility_name}:{rec.state}"
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = rec
            continue
        duplicates.append(f"{rec.facility_name} ({rec.state}) in {rec.source_file}")
        if richness(rec) > richness(existing):
            merged = FacilityPolicyRecord.from_dict({**existing.to_dict(), **{
                k: v for k, v in rec.to_dict().items()
                if v not in (None, "", [], {})
            }})
            merged.confidence = min(existing.confidence, rec.confidence)
            by_key[key] = merged

    return list(by_key.values()), duplicates


def build_index(records: list[FacilityPolicyRecord]) -> dict:
    by_name: dict[str, str] = {}
    by_state: dict[str, list[str]] = defaultdict(list)

    for rec in records:
        by_name[rec.normalized_facility_name] = rec.facility_name
        for alias in rec.aliases:
            by_name[normalize_facility_name(alias)] = rec.facility_name
        if rec.state:
            if rec.facility_name not in by_state[rec.state]:
                by_state[rec.state].append(rec.facility_name)

    return {
        "version": "1",
        "updated_at": str(date.today()),
        "facility_count": len(records),
        "by_normalized_name": by_name,
        "by_state": dict(by_state),
    }


def coverage_stats(records: list[FacilityPolicyRecord]) -> dict[str, int]:
    return {
        "books_allowed_known": sum(1 for r in records if r.allowed_books is not None),
        "magazines_allowed_known": sum(1 for r in records if r.allowed_magazines is not None),
        "newspapers_allowed_known": sum(1 for r in records if r.allowed_newspapers is not None),
        "policy_url_present": sum(1 for r in records if r.policy_url),
        "restriction_notes_present": sum(
            1 for r in records if r.restricted_content or r.disallowed_formats
        ),
        "actionable_policy": sum(1 for r in records if r.has_actionable_policy()),
    }


def audit_csv_columns(files: list[Path] | None = None) -> dict:
    """Scan CSV headers and sample values for column mapping audit."""
    files = files or discover_csv_files()
    column_files: dict[str, set[str]] = defaultdict(set)
    column_samples: dict[str, list[str]] = defaultdict(list)

    for path in files:
        rel = path.name
        try:
            with open(path, newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                if not reader.fieldnames:
                    continue
                for col in reader.fieldnames:
                    col = (col or "").strip()
                    if not col:
                        continue
                    column_files[col].add(rel)
                for i, row in enumerate(reader):
                    if i >= 3:
                        break
                    for col in reader.fieldnames or []:
                        col = (col or "").strip()
                        val = (row.get(col) or "").strip()
                        if val and len(column_samples[col]) < 3 and val not in column_samples[col]:
                            column_samples[col].append(val[:120])
        except Exception:
            continue

    def maps_to(col: str) -> list[str]:
        norm = _norm_header(col)
        matched: list[str] = []
        for group, aliases in AUDIT_FIELD_GROUPS.items():
            if any(_norm_header(a) == norm for a in aliases):
                matched.append(group)
        return matched

    all_columns = sorted(column_files.keys(), key=lambda c: (-len(column_files[c]), c.lower()))
    mapped_columns: dict[str, list[str]] = defaultdict(list)
    unmapped: list[str] = []

    for col in all_columns:
        targets = maps_to(col)
        if targets:
            for t in targets:
                mapped_columns[t].append(col)
        else:
            unmapped.append(col)

    return {
        "file_count": len(files),
        "columns": [
            {
                "name": col,
                "file_count": len(column_files[col]),
                "samples": column_samples.get(col, []),
                "maps_to": maps_to(col),
            }
            for col in all_columns
        ],
        "mapped_columns": dict(mapped_columns),
        "unmapped_columns": unmapped,
    }


def main() -> int:
    files = discover_csv_files()
    print(f"Discovered {len(files)} CSV file(s)")

    all_records: list[FacilityPolicyRecord] = []
    all_errors: list[str] = []
    skipped: list[str] = []

    for path in files:
        recs, errs = load_csv_file(path)
        if recs:
            print(f"  loaded {len(recs)} row(s) from {path.name}")
            all_records.extend(recs)
        else:
            skipped.append(str(path))
        all_errors.extend(errs)

    deduped, dupes = deduplicate_records(all_records)
    stats = coverage_stats(deduped)

    payload = {
        "version": "1",
        "updated_at": str(date.today()),
        "source_file_count": len(files),
        "row_count_raw": len(all_records),
        "facility_count": len(deduped),
        "coverage": stats,
        "parse_errors": all_errors,
        "duplicate_facilities": dupes,
        "skipped_files": skipped,
        "facilities": [r.to_dict() for r in deduped],
    }

    with open(NORMALIZED_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print(f"Wrote {len(deduped)} facilities -> {NORMALIZED_JSON}")

    index = build_index(deduped)
    with open(INDEX_JSON, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
    print(f"Wrote index -> {INDEX_JSON}")

    print("Coverage:")
    print(f"  books_allowed known:     {stats['books_allowed_known']}")
    print(f"  magazines_allowed known: {stats['magazines_allowed_known']}")
    print(f"  newspapers_allowed known:{stats['newspapers_allowed_known']}")
    print(f"  policy_url present:      {stats['policy_url_present']}")
    print(f"  restriction notes:       {stats['restriction_notes_present']}")
    print(f"  actionable policy:       {stats['actionable_policy']}")

    if all_errors:
        print(f"Parse errors: {len(all_errors)}")
        for err in all_errors[:20]:
            print(f"  - {err}")

    if dupes:
        print(f"Duplicate facilities merged: {len(dupes)}")

    from app.facility.policy_service import load_policy_records

    load_policy_records(reload=True)
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
