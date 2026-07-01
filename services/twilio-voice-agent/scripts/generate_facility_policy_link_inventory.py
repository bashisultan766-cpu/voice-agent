#!/usr/bin/env python3
"""Generate docs/FACILITY_POLICY_LINK_INVENTORY.md from normalized facility data."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.facility.policy_link_inventory import audit_policy_links  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit facility policy URLs")
    parser.add_argument(
        "--test-reachability",
        action="store_true",
        help="Probe a sample of URLs (offline maintenance only)",
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=0,
        help="Number of URLs to probe when --test-reachability is set",
    )
    args = parser.parse_args()

    data_path = ROOT / "app" / "data" / "facility_policies_normalized.json"
    inv = audit_policy_links(
        data_path=data_path,
        test_reachability=args.test_reachability,
        reachability_sample=args.sample,
    )

    out = ROOT.parents[1] / "docs" / "FACILITY_POLICY_LINK_INVENTORY.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(inv.to_markdown(), encoding="utf-8")
    print(f"Wrote {out}")
    print(f"total={inv.total_facilities} with_url={inv.facilities_with_policy_url} "
          f"unique={inv.unique_policy_urls}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
