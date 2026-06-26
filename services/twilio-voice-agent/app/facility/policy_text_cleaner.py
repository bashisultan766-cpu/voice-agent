"""Clean raw facility policy text extracted offline from HTML/PDF sources."""
from __future__ import annotations

import re

_NAV_PATTERNS = [
    re.compile(r"\b(skip to (?:main )?content|menu|navigation|breadcrumb)\b", re.I),
    re.compile(r"\b(home|contact us|site map|privacy policy|terms of use)\b", re.I),
    re.compile(r"\b(click here|read more|learn more|back to top)\b", re.I),
]

_BOILERPLATE_LINES = re.compile(
    r"^(copyright|all rights reserved|page \d+ of \d+|last updated|"
    r"powered by|cookie policy|accessibility)\b",
    re.I | re.M,
)

_BROKEN_LINE = re.compile(r"(\w)-\n(\w)")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_MULTI_NEWLINE = re.compile(r"\n{3,}")


def clean_policy_text(raw: str) -> str:
    """Normalize policy text while preserving restriction-relevant content."""
    if not raw:
        return ""

    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = _BROKEN_LINE.sub(r"\1\2", text)
    text = _BOILERPLATE_LINES.sub("", text)

    lines: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            lines.append("")
            continue
        if any(p.search(stripped) for p in _NAV_PATTERNS):
            continue
        if len(stripped) < 4 and not re.search(r"[a-zA-Z]{2,}", stripped):
            continue
        lines.append(stripped)

    text = "\n".join(lines)
    text = _MULTI_SPACE.sub(" ", text)
    text = _MULTI_NEWLINE.sub("\n\n", text)
    return text.strip()


def extract_mail_policy_sections(text: str) -> str:
    """Prefer paragraphs mentioning mail, books, publications, or inmate correspondence."""
    if not text:
        return ""
    keywords = re.compile(
        r"\b(mail|correspondence|publication|book|magazine|newspaper|inmate|"
        r"vendor|publisher|package|prohibited|restricted|allowed|permitted)\b",
        re.I,
    )
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    relevant = [p for p in paragraphs if keywords.search(p)]
    if relevant:
        return "\n\n".join(relevant[:40])
    return text[:8000]
