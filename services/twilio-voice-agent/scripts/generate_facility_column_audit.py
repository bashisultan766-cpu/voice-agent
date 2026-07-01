"""One-off generator for docs/FACILITY_COLUMN_MAPPING_AUDIT.md"""
from __future__ import annotations

from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.ingest_facility_csv_policies import AUDIT_FIELD_GROUPS, audit_csv_columns  # noqa: E402

DOCS = ROOT.parents[1] / "docs" / "FACILITY_COLUMN_MAPPING_AUDIT.md"


def main() -> None:
    audit = audit_csv_columns()
    lines: list[str] = []
    lines.append("# Facility Column Mapping Audit")
    lines.append("")
    lines.append("**Generated:** 2026-06-26")
    lines.append(
        "**Scope:** All CSV files in `app/data/facility_csv/` + legacy `facility_guidelines.csv`"
    )
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- CSV files scanned: **{audit['file_count']}**")
    lines.append(f"- Unique column headers: **{len(audit['columns'])}**")
    lines.append("")
    lines.append("## Canonical field mapping")
    lines.append("")
    for group, aliases in AUDIT_FIELD_GROUPS.items():
        cols = audit["mapped_columns"].get(group, [])
        lines.append(f"### {group}")
        lines.append("")
        if cols:
            for c in sorted(cols, key=str.lower):
                entry = next(x for x in audit["columns"] if x["name"] == c)
                lines.append(f"- `{c}` — {entry['file_count']} file(s)")
        else:
            lines.append("- *(no matching headers found)*")
        lines.append("")
        alias_preview = ", ".join(f"`{a}`" for a in aliases[:14])
        if len(aliases) > 14:
            alias_preview += " ..."
        lines.append(f"Alias list: {alias_preview}")
        lines.append("")

    lines.append("## Every column (frequency + samples)")
    lines.append("")
    lines.append("| Column | Files | Maps to | Sample values |")
    lines.append("|--------|------:|---------|---------------|")
    for col in audit["columns"]:
        maps = ", ".join(col["maps_to"]) if col["maps_to"] else "—"
        samples = "; ".join(col["samples"][:2]).replace("|", "/") or "—"
        lines.append(
            f"| {col['name']} | {col['file_count']} | {maps} | {samples} |"
        )

    lines.append("")
    lines.append("## Unmapped columns")
    lines.append("")
    if audit["unmapped_columns"]:
        for c in audit["unmapped_columns"]:
            entry = next(x for x in audit["columns"] if x["name"] == c)
            samp = "; ".join(entry["samples"][:2]) or "—"
            lines.append(f"- `{c}` — {entry['file_count']} file(s); samples: {samp}")
    else:
        lines.append("- None")

    DOCS.parent.mkdir(parents=True, exist_ok=True)
    DOCS.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {DOCS}")


if __name__ == "__main__":
    main()
