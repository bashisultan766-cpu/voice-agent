"""Knowledge base retrieval for Eric Agent Runtime (v4.11)."""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Optional

_KB_PATH = Path(__file__).resolve().parent.parent / "data" / "eric_knowledge_base.md"

_INTENT_SECTIONS: dict[str, list[str]] = {
    "shipping_question": ["Shipping / Subtotal", "Shipping / Subtotal"],
    "facility_approval": ["Facility / Inmate Orders"],
    "facility_restriction": ["Facility / Inmate Orders"],
    "address_update": ["Address Update"],
    "cancellation": ["Cancellation"],
    "payment_link": ["Payment Link Policy"],
    "payment_execute": ["Payment Link Policy"],
    "book_search": ["Product / Book Search"],
    "book_topic_allowed": ["Product / Book Search", "Off-Domain Boundary"],
    "out_of_domain": ["Off-Domain Boundary"],
    "vague_book_request": ["Product / Book Search"],
    "backorder": ["Backorder"],
    "book_not_listed": ["Book Not Listed"],
    "call_resume": ["Call Cutoff"],
}

_TOPIC_KEYWORDS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"red\s+river\s+vengeance", re.I), "Red River Vengeance"),
    (re.compile(r"processing\s+fee", re.I), "Processing Fee Ban"),
    (re.compile(r"subtotal|shipping", re.I), "Shipping / Subtotal"),
    (re.compile(r"facility|inmate|prison|jail", re.I), "Facility / Inmate Orders"),
    (re.compile(r"jessica|address\s+update", re.I), "Address Update"),
    (re.compile(r"cancel", re.I), "Cancellation"),
    (re.compile(r"backorder", re.I), "Backorder"),
    (re.compile(r"trump|politics|sport|football|weather|president", re.I), "Off-Domain Boundary"),
]


@lru_cache(maxsize=1)
def _load_sections() -> dict[str, str]:
    if not _KB_PATH.exists():
        return {}
    text = _KB_PATH.read_text(encoding="utf-8")
    sections: dict[str, str] = {}
    current = ""
    buf: list[str] = []
    for line in text.splitlines():
        if line.startswith("## "):
            if current:
                sections[current] = "\n".join(buf).strip()
            current = line[3:].strip()
            buf = []
        elif current:
            buf.append(line)
    if current:
        sections[current] = "\n".join(buf).strip()
    return sections


def is_knowledge_base_loaded() -> bool:
    return bool(_load_sections())


def retrieve_knowledge_snippets(
    user_turn: str,
    intent: str = "",
    state: Optional[object] = None,
    max_snippets: int = 3,
    max_chars: int = 1200,
) -> list[str]:
    """Return relevant knowledge snippets — controlled prompt size."""
    sections = _load_sections()
    if not sections:
        return []

    wanted: list[str] = []
    for heading in _INTENT_SECTIONS.get(intent, []):
        if heading not in wanted:
            wanted.append(heading)

    for pattern, heading in _TOPIC_KEYWORDS:
        if pattern.search(user_turn) and heading not in wanted:
            wanted.append(heading)

    if state is not None:
        pfs = getattr(state, "payment_flow_status", "idle") or "idle"
        if pfs != "idle" and "Payment Link Policy" not in wanted:
            wanted.append("Payment Link Policy")

    snippets: list[str] = []
    total = 0
    for heading in wanted[:max_snippets]:
        body = sections.get(heading, "")
        if not body:
            continue
        chunk = f"[{heading}] {body[:400]}"
        if total + len(chunk) > max_chars:
            break
        snippets.append(chunk)
        total += len(chunk)
    return snippets
