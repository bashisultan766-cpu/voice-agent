"""Deterministic product content classifier for facility policy matching."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

ContentType = Literal["book", "magazine", "newspaper", "subscription", "unknown"]
RiskFlag = Literal[
    "explicit",
    "nudity",
    "violence",
    "maps",
    "hardcover",
    "used_book",
    "unknown",
]


@dataclass
class ProductContentClassification:
    content_type: ContentType = "unknown"
    risk_flags: list[RiskFlag] = field(default_factory=list)
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "content_type": self.content_type,
            "risk_flags": list(self.risk_flags),
            "confidence": round(self.confidence, 3),
        }


_MAGAZINE_RE = re.compile(
    r"\b(magazine|periodical|subscription magazine|weekly magazine)\b", re.I
)
_NEWSPAPER_RE = re.compile(
    r"\b(newspaper|daily news|wall street journal|usa today|ny times|"
    r"new york times|chicago tribune|subscription newspaper)\b",
    re.I,
)
_BOOK_RE = re.compile(
    r"\b(book|paperback|hardcover|isbn|novel|bible|dictionary|textbook)\b", re.I
)
_SUBSCRIPTION_RE = re.compile(r"\b(subscription|renewal)\b", re.I)

_RISK_PATTERNS: list[tuple[RiskFlag, re.Pattern[str]]] = [
    ("explicit", re.compile(r"\b(explicit|erotica|adult only|xxx|pornograph)\b", re.I)),
    ("nudity", re.compile(r"\b(nude|nudity|naked|playboy|penthouse)\b", re.I)),
    ("violence", re.compile(r"\b(violen|gang|murder|weapon|tactical)\b", re.I)),
    ("maps", re.compile(r"\b(map|atlas|cartograph)\b", re.I)),
    ("hardcover", re.compile(r"\b(hardcover|hard cover|hard-back)\b", re.I)),
    ("used_book", re.compile(r"\b(used book|pre-?owned|secondhand)\b", re.I)),
]


def classify_product_content(
    *,
    product_title: str = "",
    product_description: str = "",
    product_tags: Optional[list[str]] = None,
    product_type: str = "",
    metafields: Optional[dict[str, Any]] = None,
) -> ProductContentClassification:
    """Classify product content type and risk flags from catalog metadata."""
    parts = [
        product_title or "",
        product_description or "",
        product_type or "",
        " ".join(product_tags or []),
    ]
    if metafields:
        parts.extend(str(v) for v in metafields.values() if v)
    blob = " ".join(parts).strip()
    if not blob:
        return ProductContentClassification(confidence=0.0)

    lower = blob.lower()
    content_type: ContentType = "unknown"
    confidence = 0.5

    if _NEWSPAPER_RE.search(blob):
        content_type = "newspaper"
        confidence = 0.9
    elif _MAGAZINE_RE.search(blob):
        content_type = "magazine"
        confidence = 0.9
    elif _BOOK_RE.search(blob):
        content_type = "book"
        confidence = 0.85
    elif _SUBSCRIPTION_RE.search(blob):
        content_type = "subscription"
        confidence = 0.7

    if product_type:
        pt = product_type.lower()
        if "magazine" in pt:
            content_type = "magazine"
            confidence = max(confidence, 0.92)
        elif "newspaper" in pt:
            content_type = "newspaper"
            confidence = max(confidence, 0.92)
        elif "book" in pt:
            content_type = "book"
            confidence = max(confidence, 0.88)

    risk_flags: list[RiskFlag] = []
    for flag, pattern in _RISK_PATTERNS:
        if pattern.search(blob):
            risk_flags.append(flag)

    if not risk_flags and content_type == "unknown":
        risk_flags.append("unknown")

    if content_type != "unknown":
        confidence = max(confidence, 0.75)

    return ProductContentClassification(
        content_type=content_type,
        risk_flags=risk_flags,
        confidence=confidence,
    )
