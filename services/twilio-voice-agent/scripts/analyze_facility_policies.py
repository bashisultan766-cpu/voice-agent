#!/usr/bin/env python3
"""Offline pipeline: clean raw policy text, analyze, write knowledge index."""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.facility.policy_analyzer import (  # noqa: E402
    FacilityPolicyAnalysis,
    analyze_from_csv_record,
    analyze_policy_text,
    build_knowledge_index,
    url_hash,
)
from app.facility.policy_models import FacilityPolicyRecord  # noqa: E402
from app.facility.policy_text_cleaner import clean_policy_text  # noqa: E402

logger = logging.getLogger(__name__)

_DATA_PATH = ROOT / "app" / "data" / "facility_policies_normalized.json"
_RAW_DIR = ROOT / "app" / "data" / "facility_policy_raw"
_ANALYSIS_PATH = ROOT / "app" / "data" / "facility_policy_analysis.json"
_INDEX_PATH = ROOT / "app" / "data" / "facility_policy_knowledge_index.json"


def _load_raw_text(policy_url: str) -> str:
    if not policy_url:
        return ""
    h = url_hash(policy_url)
    path = _RAW_DIR / f"{h}.txt"
    if path.exists():
        return path.read_text(encoding="utf-8", errors="ignore")
    return ""


def summarize_analysis_results(analysis_path: Path = _ANALYSIS_PATH) -> dict[str, Any]:
    """Summarize analysis JSON for QA reporting."""
    if not analysis_path.exists():
        return {}
    payload = json.loads(analysis_path.read_text(encoding="utf-8"))
    analyses = payload.get("analyses") or []
    buckets = {"high": 0, "medium": 0, "low": 0, "none": 0}
    stats: dict[str, Any] = {
        "facilities_analyzed": len(analyses),
        "books_policy_detected": 0,
        "magazines_policy_detected": 0,
        "newspapers_policy_detected": 0,
        "vendor_publisher_required": 0,
        "restricted_content_detected": 0,
        "evidence_snippets_created": 0,
        "confidence_distribution": buckets,
    }
    for row in analyses:
        if not isinstance(row, dict):
            continue
        if row.get("books_allowed") is not None:
            stats["books_policy_detected"] += 1
        if row.get("magazines_allowed") is not None:
            stats["magazines_policy_detected"] += 1
        if row.get("newspapers_allowed") is not None:
            stats["newspapers_policy_detected"] += 1
        if row.get("vendor_required") or row.get("publisher_only_required"):
            stats["vendor_publisher_required"] += 1
        restricted = any(
            row.get(k) is True
            for k in (
                "explicit_content_restricted",
                "nudity_restricted",
                "violence_restricted",
                "maps_restricted",
                "staples_binding_restricted",
            )
        ) or row.get("books_allowed") is False or row.get("magazines_allowed") is False
        if restricted:
            stats["restricted_content_detected"] += 1
        if row.get("evidence_snippets"):
            stats["evidence_snippets_created"] += 1
        conf = float(row.get("confidence") or 0.0)
        if conf >= 0.75:
            buckets["high"] += 1
        elif conf >= 0.55:
            buckets["medium"] += 1
        elif conf > 0:
            buckets["low"] += 1
        else:
            buckets["none"] += 1
    return stats


def run_analyze(*, limit: int = 0) -> dict[str, Any]:
    payload = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    facilities = payload.get("facilities") or []
    if limit > 0:
        facilities = facilities[:limit]

    analyses: list[FacilityPolicyAnalysis] = []
    from_ingested = 0
    from_csv = 0

    for row in facilities:
        if not isinstance(row, dict):
            continue
        record = FacilityPolicyRecord.from_dict(row)
        raw = _load_raw_text(record.policy_url)
        if raw.strip():
            cleaned = clean_policy_text(raw)
            analysis = analyze_policy_text(
                cleaned,
                facility_name=record.facility_name,
                state=record.state,
                policy_url=record.policy_url,
                csv_record=record,
            )
            from_ingested += 1
        else:
            analysis = analyze_from_csv_record(record)
            from_csv += 1
        analyses.append(analysis)

    analysis_payload = {
        "version": "1",
        "updated_at": date.today().isoformat(),
        "facility_count": len(analyses),
        "analyses": [a.to_dict() for a in analyses],
    }
    _ANALYSIS_PATH.write_text(json.dumps(analysis_payload, indent=2), encoding="utf-8")

    index = build_knowledge_index(analyses)
    index["updated_at"] = date.today().isoformat()
    _INDEX_PATH.write_text(json.dumps(index, indent=2), encoding="utf-8")

    summary = summarize_analysis_results(_ANALYSIS_PATH)
    summary.update({
        "total": len(facilities),
        "from_ingested": from_ingested,
        "from_csv": from_csv,
        "escalation": sum(1 for a in analyses if a.escalation_required),
    })
    logger.info(
        "analyzed total=%d ingested=%d csv=%d escalation=%d",
        summary["total"],
        summary["from_ingested"],
        summary["from_csv"],
        summary["escalation"],
    )
    return summary


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Analyze facility policies offline")
    parser.add_argument("--limit", type=int, default=0, help="Max facilities (0=all)")
    args = parser.parse_args()
    stats = run_analyze(limit=args.limit)
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
