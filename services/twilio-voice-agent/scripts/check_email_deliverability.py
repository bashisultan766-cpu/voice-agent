#!/usr/bin/env python3
"""Static email deliverability configuration check (v4.7). No secrets printed."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import get_settings
from app.email.deliverability import check_deliverability_config


def main() -> int:
    settings = get_settings()
    report = check_deliverability_config(settings)
    print("Email deliverability configuration")
    print(f"  from domain: {report['from_domain']}")
    print(f"  from email configured: {'yes' if report['from_email_configured'] else 'no'}")
    print(f"  reply-to configured: {'yes' if report['reply_to_configured'] else 'no'}")
    print(f"  brand name: {report['brand_name']}")
    print(f"  {report['dmarc_reminder']}")
    return 0 if report["from_email_configured"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
