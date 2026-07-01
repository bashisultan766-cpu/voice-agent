"""Audit facility policy URLs from normalized CSV data (offline only)."""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

_DATA_PATH = Path(__file__).parent.parent / "data" / "facility_policies_normalized.json"

_URL_RE = re.compile(r"^https?://", re.I)
_PDF_HINT_RE = re.compile(r"\.pdf(?:\?|$)|/pdf(?:/|$)", re.I)


@dataclass
class PolicyLinkInventory:
    total_facilities: int = 0
    facilities_with_policy_url: int = 0
    unique_policy_urls: int = 0
    duplicate_url_count: int = 0
    duplicate_url_examples: list[dict[str, Any]] = field(default_factory=list)
    missing_policy_url: int = 0
    invalid_urls: list[str] = field(default_factory=list)
    domains: dict[str, int] = field(default_factory=dict)
    likely_pdf_links: int = 0
    likely_html_links: int = 0
    unreachable_links: list[dict[str, str]] = field(default_factory=list)

    def to_markdown(self) -> str:
        lines = [
            "# Facility Policy Link Inventory",
            "",
            f"**Generated from:** `app/data/facility_policies_normalized.json`",
            "",
            "## Summary",
            "",
            "| Metric | Count |",
            "|--------|------:|",
            f"| Total facilities | {self.total_facilities:,} |",
            f"| Facilities with policy_url | {self.facilities_with_policy_url:,} |",
            f"| Unique policy URLs | {self.unique_policy_urls:,} |",
            f"| Duplicate URLs (shared by 2+ facilities) | {self.duplicate_url_count:,} |",
            f"| Missing policy URLs | {self.missing_policy_url:,} |",
            f"| Invalid URLs | {len(self.invalid_urls):,} |",
            f"| Unique domains | {len(self.domains):,} |",
            f"| Likely PDF links | {self.likely_pdf_links:,} |",
            f"| Likely HTML links | {self.likely_html_links:,} |",
            f"| Unreachable links tested | {len(self.unreachable_links):,} |",
            "",
        ]
        if self.domains:
            lines.extend(["## Top domains", ""])
            for domain, count in sorted(self.domains.items(), key=lambda x: -x[1])[:25]:
                lines.append(f"- `{domain or '(empty)'}` — {count}")
            lines.append("")
        if self.duplicate_url_examples:
            lines.extend(["## Duplicate URL examples (top 10)", ""])
            for item in self.duplicate_url_examples[:10]:
                lines.append(f"- `{item['url']}` — {item['facility_count']} facilities")
            lines.append("")
        if self.invalid_urls:
            lines.extend(["## Invalid URL samples", ""])
            for url in self.invalid_urls[:15]:
                lines.append(f"- `{url}`")
            lines.append("")
        if self.unreachable_links:
            lines.extend(["## Unreachable links (sample test)", ""])
            for item in self.unreachable_links[:20]:
                lines.append(f"- `{item['url']}` — {item.get('error', 'unreachable')}")
            lines.append("")
        lines.append(
            "> **Note:** This inventory is read-only. Policy text is fetched offline via "
            "`scripts/fetch_facility_policy_links.py` — never during live calls."
        )
        return "\n".join(lines)


def _is_pdf_url(url: str) -> bool:
    return bool(_PDF_HINT_RE.search(url.lower()))


def audit_policy_links(
    *,
    data_path: Path | None = None,
    test_reachability: bool = False,
    reachability_sample: int = 0,
) -> PolicyLinkInventory:
    path = data_path or _DATA_PATH
    payload = json.loads(path.read_text(encoding="utf-8"))
    facilities = payload.get("facilities") or []

    inv = PolicyLinkInventory(total_facilities=len(facilities))
    url_to_facilities: dict[str, list[str]] = {}
    all_urls: list[str] = []

    for row in facilities:
        if not isinstance(row, dict):
            continue
        url = (row.get("policy_url") or "").strip()
        name = str(row.get("facility_name") or "")
        if not url:
            inv.missing_policy_url += 1
            continue
        inv.facilities_with_policy_url += 1
        all_urls.append(url)
        url_to_facilities.setdefault(url, []).append(name)
        if not _URL_RE.match(url):
            inv.invalid_urls.append(url)

    unique_urls = set(all_urls)
    inv.unique_policy_urls = len(unique_urls)
    domain_counter: Counter[str] = Counter()
    for url in unique_urls:
        if _is_pdf_url(url):
            inv.likely_pdf_links += 1
        else:
            inv.likely_html_links += 1
        try:
            domain_counter[urlparse(url).netloc.lower()] += 1
        except Exception:
            domain_counter[""] += 1

    inv.domains = dict(domain_counter)
    dupes = {u: names for u, names in url_to_facilities.items() if len(names) > 1}
    inv.duplicate_url_count = len(dupes)
    inv.duplicate_url_examples = [
        {"url": u, "facility_count": len(names)}
        for u, names in sorted(dupes.items(), key=lambda x: -len(x[1]))[:20]
    ]

    if test_reachability and reachability_sample > 0:
        inv.unreachable_links = _test_reachability(
            list(unique_urls)[:reachability_sample]
        )

    return inv


def _test_reachability(urls: list[str]) -> list[dict[str, str]]:
    """Optional offline reachability probe (not used in live calls)."""
    import httpx

    failures: list[dict[str, str]] = []
    for url in urls:
        try:
            with httpx.Client(timeout=8.0, follow_redirects=True) as client:
                resp = client.head(url)
                if resp.status_code >= 400:
                    failures.append({"url": url, "error": f"HTTP {resp.status_code}"})
        except Exception as exc:
            failures.append({"url": url, "error": str(exc)[:120]})
    return failures
