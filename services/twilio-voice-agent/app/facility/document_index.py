"""
PDF / text document index for facility guidelines (v4.34).

Place client PDFs in: ``app/data/facility_docs/``

Run: ``python -m app.scripts.ingest_facility_documents`` to extract text and merge
into ``facility_guidelines.json``.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DOCS_DIR = Path(__file__).parent.parent / "data" / "facility_docs"
_INDEX_PATH = Path(__file__).parent.parent / "data" / "facility_docs_index.json"

_URL_RE = re.compile(r"https?://[^\s\]>)\",]+", re.I)
_SKIP_FILES = re.compile(r"^(readme|\.gitkeep)", re.I)

_FORMAT_RULES = [
    (re.compile(r"\b(no hardcover|hardcover (?:not|is )?(?:allowed|permitted|accepted)|hardcovers? (?:banned|prohibited|rejected))\b", re.I), "hardcover"),
    (re.compile(r"\b(paperback only|softcover only|paperbacks? only)\b", re.I), "paperback_only"),
    (re.compile(r"\b(new books? only|no used books?)\b", re.I), "used_ban"),
]

_CONTENT_PATTERNS = [
  re.compile(r"\b(not allowed|prohibited|banned|rejected|restricted|will be returned)\b[^.\n]{0,120}", re.I),
  re.compile(r"\b(no|not permitted)[^.\n]{0,80}\b(books?|magazines?|publications?)\b", re.I),
]


def _load_index() -> list[dict[str, Any]]:
    if not _INDEX_PATH.exists():
        return []
    try:
        with open(_INDEX_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else data.get("documents", [])
    except Exception as exc:
        logger.warning("facility_docs_index load failed: %s", exc)
        return []


def extract_pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        logger.warning("pypdf not installed — pip install pypdf to ingest PDFs")
        return ""
    try:
        reader = PdfReader(str(path))
        parts = []
        for page in reader.pages[:80]:
            text = page.extract_text() or ""
            if text.strip():
                parts.append(text.strip())
        return "\n\n".join(parts)
    except Exception as exc:
        logger.error("PDF extract failed %s: %s", path.name, exc)
        return ""


def extract_text_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        logger.error("Text read failed %s: %s", path.name, exc)
        return ""


def guess_facility_names_from_filename(filename: str) -> list[str]:
    """Derive facility name hints from filename like 'tdcj_huntsville_rules.pdf'."""
    stem = Path(filename).stem
    stem = re.sub(r"[_\-]+", " ", stem)
    stem = re.sub(
        r"\b(rules|guidelines|mail|policy|approved|list|doc|cdcr|tdcj)\b",
        "",
        stem,
        flags=re.I,
    )
    stem = re.sub(r"\s+", " ", stem).strip()
    return [stem] if stem and len(stem) > 2 else []


def extract_urls(text: str) -> list[str]:
    seen: set[str] = set()
    urls: list[str] = []
    for m in _URL_RE.findall(text or ""):
        u = m.rstrip(".,;)")
        if u not in seen:
            seen.add(u)
            urls.append(u)
    return urls[:10]


def extract_rules_from_text(text: str) -> dict[str, Any]:
    """Heuristic rule extraction from raw document text (PDF / paste)."""
    t = text or ""
    lower = t.lower()

    disallowed_formats: list[str] = []
    allowed_formats: list[str] = []
    disallowed_keywords: list[str] = []
    content_snippets: list[str] = []

    if re.search(r"\bhardcover\b", lower) and re.search(
        r"\b(not allowed|prohibited|banned|rejected|no hardcover|paperback only)\b",
        lower,
    ):
        disallowed_formats.append("hardcover")
    if re.search(r"\b(paperback|softcover)\b", lower) and re.search(
        r"\b(only|accepted|allowed|permitted)\b",
        lower,
    ):
        allowed_formats.extend(["paperback", "softcover"])

    keyword_seeds = [
        "violence", "gang", "explicit", "erotica", "nude", "tattoo", "adult",
        "sexual", "weapon", "drug", "escape", "contraband", "magazine",
        "hardcover", "used book", "sticker", "glitter", "pop-up",
    ]
    for kw in keyword_seeds:
        if kw in lower:
            disallowed_keywords.append(kw)

    for pat in _CONTENT_PATTERNS:
        for m in pat.finditer(t):
            snippet = re.sub(r"\s+", " ", m.group(0)).strip()
            if 12 < len(snippet) < 200 and snippet not in content_snippets:
                content_snippets.append(snippet)

    urls = extract_urls(t)
    website_url = urls[0] if urls else ""
    website_name = ""
    if website_url:
        host = re.sub(r"^https?://(www\.)?", "", website_url).split("/")[0]
        website_name = host.replace(".", " ").title()

    notes = " ".join(content_snippets[:4])
    if len(notes) > 500:
        notes = notes[:500] + "…"

    return {
        "website_url": website_url,
        "website_name": website_name,
        "urls": urls,
        "allowed_formats": list(dict.fromkeys(allowed_formats)),
        "disallowed_formats": list(dict.fromkeys(disallowed_formats)),
        "disallowed_keywords": list(dict.fromkeys(disallowed_keywords)),
        "content_notes": notes,
        "content_snippets": content_snippets[:8],
    }


def build_document_index() -> list[dict[str, Any]]:
    """Scan facility_docs/ and build index entries."""
    _DOCS_DIR.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []

    for path in sorted(_DOCS_DIR.iterdir()):
        if path.name.startswith(".") or _SKIP_FILES.search(path.name):
            continue
        if path.suffix.lower() == ".pdf":
            text = extract_pdf_text(path)
        elif path.suffix.lower() in (".txt", ".md"):
            text = extract_text_file(path)
        else:
            continue

        if not text or text.strip().startswith("# Place client"):
            continue

        rules = extract_rules_from_text(text)
        entries.append({
            "filename": path.name,
            "facility_name_hints": guess_facility_names_from_filename(path.name),
            "char_count": len(text),
            "excerpt": text[:3000],
            "full_text": text[:80000],
            "extracted_rules": rules,
            "website_url": rules.get("website_url", ""),
            "website_name": rules.get("website_name", ""),
        })

    return entries


def save_document_index(entries: list[dict[str, Any]]) -> None:
    with open(_INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump({"documents": entries, "count": len(entries)}, f, indent=2)


def document_for_facility(facility_name: str) -> dict[str, Any] | None:
    """Return the best matching indexed document for a facility name."""
    norm = re.sub(r"[^a-z0-9]", "", facility_name.lower())
    if not norm:
        return None

    best: tuple[int, dict[str, Any] | None] = (0, None)
    for doc in _load_index():
        hints = doc.get("facility_name_hints") or []
        score = 0
        for hint in hints:
            hnorm = re.sub(r"[^a-z0-9]", "", hint.lower())
            if hnorm and (hnorm in norm or norm in hnorm):
                score = max(score, len(hnorm))
        fnorm = re.sub(r"[^a-z0-9]", "", (doc.get("filename") or "").lower())
        if norm in fnorm:
            score = max(score, len(norm))
        if score > best[0]:
            best = (score, doc)
    return best[1]


def excerpt_for_facility(facility_name: str, *, max_chars: int = 1200) -> str:
    """Return best-matching document excerpt for a facility name."""
    doc = document_for_facility(facility_name)
    if not doc:
        return ""
    excerpt = doc.get("excerpt") or doc.get("full_text") or ""
    rules = doc.get("extracted_rules") or {}
    snippets = rules.get("content_snippets") or []
    if snippets:
        lead = "Key rules from document: " + " | ".join(snippets[:3])
        return (lead + "\n\n" + excerpt)[:max_chars]
    return excerpt[:max_chars]


def rules_for_facility(facility_name: str) -> dict[str, Any]:
    """Return extracted rules from the best matching PDF/text document."""
    doc = document_for_facility(facility_name)
    if not doc:
        return {}
    return doc.get("extracted_rules") or extract_rules_from_text(
        doc.get("full_text") or doc.get("excerpt") or ""
    )
