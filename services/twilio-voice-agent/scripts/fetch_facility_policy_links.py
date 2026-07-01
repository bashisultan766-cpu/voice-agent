#!/usr/bin/env python3
"""
Offline facility policy link fetcher.

Fetches policy pages/documents from CSV policy_url values and caches raw text.
Never called during live customer calls.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.facility.policy_analyzer import url_hash  # noqa: E402

logger = logging.getLogger(__name__)

_DATA_PATH = ROOT / "app" / "data" / "facility_policies_normalized.json"
_RAW_DIR = ROOT / "app" / "data" / "facility_policy_raw"
_DEFAULT_TIMEOUT = 20.0
_USER_AGENT = "SureShotBooks-FacilityPolicyIngest/1.0 (+offline; no-live-calls)"
_PDF_RE = re.compile(r"\.pdf(?:\?|$)|application/pdf", re.I)


class _TextHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []
        self._skip = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "nav", "header", "footer"}:
            self._skip = True

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "nav", "header", "footer"}:
            self._skip = False
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr"}:
            self._chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip and data.strip():
            self._chunks.append(data.strip() + " ")

    def text(self) -> str:
        return re.sub(r"\s+", " ", "".join(self._chunks)).strip()


def _extract_html_text(html: str) -> str:
    parser = _TextHTMLParser()
    try:
        parser.feed(html)
        return parser.text()
    except Exception:
        return re.sub(r"<[^>]+>", " ", html)


def _pdf_supported() -> bool:
    try:
        import pypdf  # noqa: F401

        return True
    except ImportError:
        return False


def _extract_pdf_text(content: bytes) -> tuple[str, str | None]:
    if not _pdf_supported():
        return "", "pdf_unsupported: install pypdf"
    try:
        from io import BytesIO

        from pypdf import PdfReader

        reader = PdfReader(BytesIO(content))
        parts = []
        for page in reader.pages[:80]:
            text = page.extract_text() or ""
            if text.strip():
                parts.append(text.strip())
        return "\n\n".join(parts), None
    except Exception as exc:
        return "", f"pdf_extract_failed: {exc}"


def _robots_allowed(url: str, client: httpx.Client) -> bool:
    try:
        parsed = urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp = RobotFileParser()
        resp = client.get(robots_url, timeout=8.0)
        if resp.status_code >= 400:
            return True
        rp.parse(resp.text.splitlines())
        return rp.can_fetch(_USER_AGENT, url)
    except Exception:
        return True


def collect_policy_urls(data_path: Path = _DATA_PATH) -> dict[str, list[str]]:
    payload = json.loads(data_path.read_text(encoding="utf-8"))
    url_map: dict[str, list[str]] = {}
    for row in payload.get("facilities") or []:
        if not isinstance(row, dict):
            continue
        url = (row.get("policy_url") or "").strip()
        name = str(row.get("facility_name") or "")
        if url:
            url_map.setdefault(url, []).append(name)
    return url_map


def fetch_policy_url(
    url: str,
    *,
    client: httpx.Client,
    force: bool = False,
) -> dict[str, Any]:
    h = url_hash(url)
    text_path = _RAW_DIR / f"{h}.txt"
    meta_path = _RAW_DIR / f"{h}.metadata.json"

    if text_path.exists() and meta_path.exists() and not force:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["skipped"] = True
        return meta

    if not _robots_allowed(url, client):
        return {
            "url": url,
            "status": "blocked",
            "content_type": "",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "text_length": 0,
            "error": "robots_disallowed",
        }

    try:
        resp = client.get(url)
        content_type = resp.headers.get("content-type", "")
        status = str(resp.status_code)
        text = ""
        error = None

        if resp.status_code >= 400:
            error = f"http_{resp.status_code}"
        elif _PDF_RE.search(url) or "pdf" in content_type.lower():
            text, pdf_err = _extract_pdf_text(resp.content)
            if pdf_err:
                error = pdf_err
        else:
            text = _extract_html_text(resp.text)

        meta = {
            "url": url,
            "status": status,
            "content_type": content_type,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "text_length": len(text),
            "error": error,
        }
        if text and not error:
            text_path.write_text(text, encoding="utf-8")
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return meta
    except Exception as exc:
        return {
            "url": url,
            "status": "error",
            "content_type": "",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "text_length": 0,
            "error": str(exc)[:200],
        }


def summarize_fetch_results(raw_dir: Path = _RAW_DIR) -> dict[str, Any]:
    """Summarize cached fetch metadata (offline QA report)."""
    url_map = collect_policy_urls()
    stats: dict[str, Any] = {
        "total_unique_urls": len(url_map),
        "success": 0,
        "failed": 0,
        "skipped": 0,
        "pdf_unsupported": 0,
        "timeout": 0,
        "empty_text": 0,
        "robots_blocked": 0,
        "failure_domains": {},
    }
    failure_domains: Counter[str] = Counter()

    if not raw_dir.exists():
        return stats

    for meta_path in raw_dir.glob("*.metadata.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        url = str(meta.get("url") or "")
        domain = urlparse(url).netloc.lower() if url else ""
        err = str(meta.get("error") or "")
        text_len = int(meta.get("text_length") or 0)

        if meta.get("skipped"):
            stats["skipped"] += 1
            if text_len > 0:
                stats["success"] += 1
            continue

        if err:
            stats["failed"] += 1
            if "pdf_unsupported" in err:
                stats["pdf_unsupported"] += 1
            if "timeout" in err.lower() or "timed out" in err.lower():
                stats["timeout"] += 1
            if err == "robots_disallowed":
                stats["robots_blocked"] += 1
            failure_domains[domain or "(empty)"] += 1
        elif text_len > 0:
            stats["success"] += 1
        else:
            stats["failed"] += 1
            stats["empty_text"] += 1
            failure_domains[domain or "(empty)"] += 1

    stats["failure_domains"] = dict(failure_domains.most_common(25))
    return stats


def run_fetch(
    *,
    force: bool = False,
    limit: int = 0,
    delay: float = 0.5,
) -> dict[str, Any]:
    _RAW_DIR.mkdir(parents=True, exist_ok=True)
    url_map = collect_policy_urls()
    urls = sorted(url_map.keys())
    if limit > 0:
        urls = urls[:limit]

    stats: dict[str, Any] = {
        "total": len(urls),
        "success": 0,
        "skipped": 0,
        "failed": 0,
        "pdf_unsupported": 0,
        "timeout": 0,
        "empty_text": 0,
        "robots_blocked": 0,
        "failure_domains": Counter(),
    }
    failure_domains: Counter[str] = stats["failure_domains"]
    headers = {"User-Agent": _USER_AGENT}

    with httpx.Client(timeout=_DEFAULT_TIMEOUT, follow_redirects=True, headers=headers) as client:
        for url in urls:
            meta = fetch_policy_url(url, client=client, force=force)
            meta["source_facilities"] = url_map.get(url, [])[:20]
            h = url_hash(url)
            meta_path = _RAW_DIR / f"{h}.metadata.json"
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

            domain = urlparse(url).netloc.lower() or "(empty)"
            err = str(meta.get("error") or "")

            if meta.get("skipped"):
                stats["skipped"] += 1
                if int(meta.get("text_length") or 0) > 0:
                    stats["success"] += 1
                logger.info("skip cached url=%s", url[:80])
            elif err:
                stats["failed"] += 1
                if "pdf_unsupported" in err:
                    stats["pdf_unsupported"] += 1
                if "timeout" in err.lower() or "timed out" in err.lower():
                    stats["timeout"] += 1
                if err == "robots_disallowed":
                    stats["robots_blocked"] += 1
                failure_domains[domain] += 1
                logger.warning("fetch failed url=%s err=%s", url[:80], err)
            elif meta.get("text_length", 0) > 0:
                stats["success"] += 1
                logger.info("fetched url=%s len=%d", url[:80], meta["text_length"])
            else:
                stats["failed"] += 1
                stats["empty_text"] += 1
                failure_domains[domain] += 1

            if delay > 0:
                time.sleep(delay)

    stats["failure_domains"] = dict(failure_domains.most_common(25))
    return stats


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Fetch facility policy links offline")
    parser.add_argument("--force", action="store_true", help="Re-fetch cached URLs")
    parser.add_argument("--limit", type=int, default=0, help="Max URLs to fetch (0=all)")
    parser.add_argument("--delay", type=float, default=0.5, help="Delay between requests (seconds)")
    args = parser.parse_args()

    stats = run_fetch(force=args.force, limit=args.limit, delay=args.delay)
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
