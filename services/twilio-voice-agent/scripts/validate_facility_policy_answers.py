#!/usr/bin/env python3
"""Validate cached facility policy answers (offline QA — no live URL fetching)."""
from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.facility.policy_service import (  # noqa: E402
    answer_facility_question,
    get_facility_policy_analysis,
    get_policy_source,
    load_policy_records,
    search_facility_policy,
)

_DATA_PATH = ROOT / "app" / "data" / "facility_policies_normalized.json"
_REPORT_PATH = ROOT.parents[1] / "docs" / "FACILITY_POLICY_ANSWER_VALIDATION.md"
_MAX_CUSTOMER_MESSAGE = 600


@dataclass
class ValidationCase:
    facility_name: str
    state: str = ""
    lookup_ok: bool = False
    source_ok: bool = False
    uses_cached_analysis: bool = False
    no_invention: bool = False
    escalation_when_low: bool = False
    has_source_reference: bool = False
    customer_friendly: bool = False
    notes: list[str] = field(default_factory=list)


def _is_customer_friendly(message: str) -> bool:
    if not message or len(message) > _MAX_CUSTOMER_MESSAGE:
        return False
    if len(message) > 2000:
        return False
    lower = message.lower()
    bad = ("<html", "<script", "lorem ipsum", "http://", "https://")
    if any(b in lower for b in bad):
        return False
    return True


def _validate_facility(name: str, state: str = "") -> ValidationCase:
    case = ValidationCase(facility_name=name, state=state)
    load_policy_records(reload=True)

    search = search_facility_policy(name, state=state or None)
    case.lookup_ok = bool(search.get("found")) or bool(search.get("facility_name"))

    source = get_policy_source(name, state=state or None)
    case.source_ok = bool(source.get("found")) and bool(
        source.get("source_file") or source.get("policy_url")
    )

    analysis = get_facility_policy_analysis(name, state=state or None)
    case.uses_cached_analysis = bool(analysis.get("analysis_found"))

    answer = answer_facility_question(
        name,
        "What is the mail policy for books and magazines?",
        state=state or None,
    )
    msg = str(answer.get("customer_message") or answer.get("message") or "")
    confidence = float(answer.get("confidence") or analysis.get("confidence") or 0.0)

    if answer.get("escalation_required"):
        case.no_invention = "forward" in msg.lower() or "don't have" in msg.lower() or "do not have" in msg.lower()
        case.escalation_when_low = confidence < 0.55 or not analysis.get("analysis_found")
    else:
        case.no_invention = bool(msg) and "guess" not in msg.lower()
        case.escalation_when_low = True

    case.has_source_reference = bool(
        source.get("policy_url")
        or source.get("source_file")
        or analysis.get("policy_url")
        or analysis.get("source_file")
        or "policy" in msg.lower()
        or "source" in msg.lower()
    )
    case.customer_friendly = _is_customer_friendly(msg)

    if not case.lookup_ok:
        case.notes.append("lookup failed")
    if not case.source_ok and search.get("found"):
        case.notes.append("missing source metadata")
    if not case.customer_friendly:
        case.notes.append("message not customer-friendly")
    return case


def sample_facilities(*, sample_size: int = 50, seed: int = 42) -> list[tuple[str, str]]:
    payload = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    rows = [
        (str(r.get("facility_name") or ""), str(r.get("state") or ""))
        for r in (payload.get("facilities") or [])
        if r.get("facility_name")
    ]
    rng = random.Random(seed)
    if len(rows) <= sample_size:
        return rows
    return rng.sample(rows, sample_size)


def run_validation(*, sample_size: int = 50, seed: int = 42) -> dict[str, Any]:
    facilities = sample_facilities(sample_size=sample_size, seed=seed)
    cases = [_validate_facility(name, state) for name, state in facilities]

    def _rate(attr: str) -> float:
        return round(sum(1 for c in cases if getattr(c, attr)) / len(cases), 3)

    return {
        "sample_size": len(cases),
        "lookup_rate": _rate("lookup_ok"),
        "source_rate": _rate("source_ok"),
        "cached_analysis_rate": _rate("uses_cached_analysis"),
        "no_invention_rate": _rate("no_invention"),
        "escalation_rate": _rate("escalation_when_low"),
        "source_reference_rate": _rate("has_source_reference"),
        "customer_friendly_rate": _rate("customer_friendly"),
        "failures": [
            {"facility": c.facility_name, "state": c.state, "notes": c.notes}
            for c in cases
            if c.notes
        ][:20],
        "cases": cases,
    }


def to_markdown(result: dict[str, Any]) -> str:
    lines = [
        "# Facility Policy Answer Validation",
        "",
        f"**Date:** {date.today().isoformat()}",
        f"**Sample size:** {result['sample_size']}",
        "",
        "## Quality metrics",
        "",
        "| Check | Pass rate |",
        "|-------|----------:|",
        f"| Facility lookup works | {result['lookup_rate']:.1%} |",
        f"| Policy source exists | {result['source_rate']:.1%} |",
        f"| Uses cached policy analysis | {result['cached_analysis_rate']:.1%} |",
        f"| No invented answer when evidence missing | {result['no_invention_rate']:.1%} |",
        f"| Escalation when confidence low | {result['escalation_rate']:.1%} |",
        f"| Answer includes source reference | {result['source_reference_rate']:.1%} |",
        f"| Customer-friendly message | {result['customer_friendly_rate']:.1%} |",
        "",
    ]
    if result.get("failures"):
        lines.extend(["## Sample failures", ""])
        for item in result["failures"]:
            lines.append(
                f"- **{item['facility']}** ({item['state'] or 'n/a'}): {', '.join(item['notes'])}"
            )
        lines.append("")
    lines.append(
        "> Offline validation only — no URLs fetched during these checks."
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate facility policy answers")
    parser.add_argument("--sample", type=int, default=50, help="Facilities to sample")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument(
        "--output",
        type=Path,
        default=_REPORT_PATH,
        help="Markdown report path",
    )
    args = parser.parse_args()

    result = run_validation(sample_size=args.sample, seed=args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(to_markdown(result), encoding="utf-8")

    summary = {k: v for k, v in result.items() if k != "cases"}
    print(json.dumps(summary, indent=2))
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
