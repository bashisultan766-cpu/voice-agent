#!/usr/bin/env python3
"""Diagnose catalog visibility for a search term (v4.14.8)."""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose Shopify catalog visibility")
    parser.add_argument("--query", default="USA Today", help="Search term to diagnose")
    args = parser.parse_args()

    from app.agent_runtime.catalog_coverage_diagnostics import (
        diagnose_catalog_visibility,
        format_diagnosis,
    )

    report = asyncio.run(diagnose_catalog_visibility(args.query))
    print(format_diagnosis(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
