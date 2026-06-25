"""Short spoken book titles for phone calls (v4.36)."""
from __future__ import annotations

import re

_DEFAULT_MAX_WORDS = 4
_LONG_TITLE_WORDS = 6


def spoken_book_title(title: str, *, max_words: int = _DEFAULT_MAX_WORDS) -> str:
    """
    Return a voice-friendly title.

    Prefer text before a subtitle colon. Otherwise use the first few words
    of long titles; short titles are read in full.
    """
    clean = re.sub(r"\s+", " ", (title or "").strip())
    if not clean:
        return "that book"
    if ":" in clean:
        head = clean.split(":", 1)[0].strip()
        if head:
            words = head.split()
            if len(words) <= _LONG_TITLE_WORDS:
                return head
            return " ".join(words[:max_words])
    words = clean.split()
    if len(words) <= _LONG_TITLE_WORDS:
        return clean
    return " ".join(words[:max_words])
