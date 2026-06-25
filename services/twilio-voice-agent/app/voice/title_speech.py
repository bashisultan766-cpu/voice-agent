"""Short spoken book titles for phone calls (v4.36)."""
from __future__ import annotations

import re

_DEFAULT_MAX_WORDS = 3
_LONG_TITLE_WORDS = 5


def spoken_book_title(title: str, *, max_words: int = _DEFAULT_MAX_WORDS) -> str:
    """
    Return a voice-friendly title.

    Short titles are read in full. Long titles use the first few words only.
    """
    clean = re.sub(r"\s+", " ", (title or "").strip())
    if not clean:
        return "that book"
    words = clean.split()
    if len(words) <= _LONG_TITLE_WORDS:
        return clean
    return " ".join(words[:max_words])
