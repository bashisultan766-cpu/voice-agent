#!/usr/bin/env python3
"""
Ingest client facility documents into structured JSON for the voice agent.

Usage:
  python -m app.scripts.ingest_facility_documents

Input files (place in app/data/):
  facility_guidelines.csv   — export from Google Sheets (see header row)
  facility_docs/*.pdf       — client PDF guideline documents
  facility_docs/*.txt       — optional plain-text copies

Output:
  app/data/facility_guidelines.json   — structured rules (agent reads this)
  app/data/facility_docs_index.json   — PDF text excerpts + extracted rules
  app/data/facility_approved_list.csv — synced approval list (backward compatible)
"""
from __future__ import annotations

import csv
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CSV_PATH = DATA / "facility_guidelines.csv"
JSON_PATH = DATA / "facility_guidelines.json"
APPROVED_CSV = DATA / "facility_approved_list.csv"


def _split_list(val: str) -> list[str]:
    if not val:
        return []
    return [x.strip().lower() for x in re.split(r"[,;|]", val) if x.strip()]


def _split_aliases(val: str) -> list[str]:
    if not val:
        return []
    return [x.strip() for x in re.split(r"[,;|]", val) if x.strip()]


def _merge_unique(base: list[str], extra: list[str]) -> list[str]:
    seen = {x.lower() for x in base}
    out = list(base)
    for item in extra:
        if item and item.lower() not in seen:
            seen.add(item.lower())
            out.append(item)
    return out


def load_csv_facilities() -> list[dict]:
    if not CSV_PATH.exists():
        print(f"CSV not found: {CSV_PATH}")
        return []

    facilities = []
    with open(CSV_PATH, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            name = (row.get("facility_name") or row.get("name") or "").strip()
            if not name:
                continue
            fid = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or f"facility-{i}"
            source_pdf = (row.get("source_pdf") or row.get("pdf_file") or "").strip()
            sources = ["facility_guidelines.csv"]
            if source_pdf:
                sources.append(f"facility_docs/{source_pdf}")

            facilities.append({
                "facility_id": fid,
                "name": name,
                "aliases": _split_aliases(row.get("aliases") or ""),
                "city": (row.get("city") or "").strip(),
                "state": (row.get("state") or "").strip(),
                "approved": str(row.get("approved", "true")).lower() in ("true", "yes", "1"),
                "website_name": (row.get("website_name") or "").strip(),
                "website_url": (row.get("website_url") or "").strip(),
                "allowed_formats": _split_list(row.get("allowed_formats") or ""),
                "disallowed_formats": _split_list(row.get("disallowed_formats") or ""),
                "disallowed_keywords": _split_list(row.get("disallowed_keywords") or ""),
                "disallowed_categories": _split_list(row.get("disallowed_categories") or ""),
                "content_notes": (row.get("content_notes") or row.get("notes") or "").strip(),
                "source_pdf": source_pdf,
                "rejection_templates": {
                    "hardcover": "This facility accepts paperback/softcover only — hardcover books are returned.",
                    "keyword": "The title or content appears to include '{keyword}', which this facility does not allow.",
                    "category": "Books in the '{category}' category are not accepted at this facility.",
                },
                "source_documents": sources,
                "document_excerpt": "",
            })
    return facilities


def sync_approved_csv(facilities: list[dict]) -> None:
    rows = []
    for f in facilities:
        rows.append({
            "facility_name": f["name"],
            "city": f.get("city", ""),
            "state": f.get("state", ""),
            "approved": "true" if f.get("approved") else "false",
            "notes": f.get("content_notes", "")[:200],
        })
    with open(APPROVED_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["facility_name", "city", "state", "approved", "notes"],
        )
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows -> {APPROVED_CSV}")


def attach_document_excerpts(facilities: list[dict]) -> None:
    from app.facility.document_index import (
        build_document_index,
        excerpt_for_facility,
        rules_for_facility,
        save_document_index,
    )

    docs = build_document_index()
    save_document_index(docs)
    print(f"Indexed {len(docs)} document(s) from facility_docs/")

    doc_by_name = {d["filename"]: d for d in docs}

    for fac in facilities:
        excerpt = excerpt_for_facility(fac["name"], max_chars=2000)
        rules = rules_for_facility(fac["name"])

        source_pdf = fac.pop("source_pdf", "")
        if source_pdf and source_pdf in doc_by_name:
            doc = doc_by_name[source_pdf]
            excerpt = (doc.get("excerpt") or "")[:2000]
            rules = doc.get("extracted_rules") or rules

        if excerpt:
            fac["document_excerpt"] = excerpt
            fac.setdefault("source_documents", []).append("facility_docs/")

        if rules:
            if not fac.get("website_url") and rules.get("website_url"):
                fac["website_url"] = rules["website_url"]
            if not fac.get("website_name") and rules.get("website_name"):
                fac["website_name"] = rules["website_name"]
            fac["allowed_formats"] = _merge_unique(
                fac.get("allowed_formats") or [],
                rules.get("allowed_formats") or [],
            )
            fac["disallowed_formats"] = _merge_unique(
                fac.get("disallowed_formats") or [],
                rules.get("disallowed_formats") or [],
            )
            fac["disallowed_keywords"] = _merge_unique(
                fac.get("disallowed_keywords") or [],
                rules.get("disallowed_keywords") or [],
            )
            if not fac.get("content_notes") and rules.get("content_notes"):
                fac["content_notes"] = rules["content_notes"]


def main() -> None:
    facilities = load_csv_facilities()
    attach_document_excerpts(facilities)

    payload = {
        "version": "1",
        "updated_at": str(date.today()),
        "global_disallowed_keywords": [
            "explicit", "erotica", "pornographic", "nude", "nudity",
        ],
        "global_notes": (
            "When a customer asks why some books arrived but others were returned: "
            "use check_order_facility_restrictions or reconcile_order_facility_books with their order number. "
            "Explain with empathy — it is frustrating when a loved one does not receive a book. "
            "Cite the specific rule from facility documents (format, content type). "
            "Always share the facility website URL when on file. "
            "Offer similar paperback alternatives that meet the facility rules."
        ),
        "facilities": facilities,
    }

    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    print(f"Wrote {len(facilities)} facilities -> {JSON_PATH}")

    if facilities:
        sync_approved_csv(facilities)

    from app.facility.guidelines_registry import load_guidelines

    load_guidelines(reload=True)
    print("Done. Restart the voice agent to load new facility data.")


if __name__ == "__main__":
    main()
