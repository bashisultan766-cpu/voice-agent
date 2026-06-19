import re
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from openai import AsyncOpenAI


class Intent(str, Enum):
    GREETING = "greeting"
    PRODUCT_SEARCH = "product_search"
    ISBN_SEARCH = "isbn_search"
    ORDER_LOOKUP = "order_lookup"
    FACILITY_CHECK = "facility_check"
    CHECKOUT = "checkout"
    EMAIL_CAPTURE = "email_capture"
    CLOSING = "closing"
    GENERAL = "general"


@dataclass
class RouterDecision:
    intent: Intent
    confidence: float
    source: str  # "deterministic" | "regex" | "llm"


# ── Compiled patterns ─────────────────────────────────────────────────────────

_ISBN_RE = re.compile(r"\b(?:97[89][- ]?)?(?:\d[- ]?){9}[\dXx]\b")
_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+\s*@\s*[a-zA-Z0-9.\-]+\s*\.[a-zA-Z]{2,}", re.I)

_GREETING_RE = re.compile(
    r"^(hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening|howdy)\b",
    re.I,
)
_CLOSING_RE = re.compile(
    r"\b(bye|goodbye|thank\s+you|thanks|that'?s\s+all|have\s+a\s+good|no\s+thank\s+you|"
    r"no\s+thanks|that\s+will\s+be\s+all)\b",
    re.I,
)
_BOOK_RE = re.compile(
    r"\b(book|novel|title|author|copy|copies|paperback|hardcover|"
    r"available|in\s+stock|do\s+you\s+have|carry|sell)\b",
    re.I,
)
_ORDER_RE = re.compile(
    r"\b(order|track|tracking|shipment|shipped|delivered|status|"
    r"cancel|cancell|refund|return)\b",
    re.I,
)
_FACILITY_RE = re.compile(
    r"\b(prison|jail|facility|correctional|inmate|incarcerated|institution|penitentiary)\b",
    re.I,
)
_BUY_RE = re.compile(
    r"\b(buy|purchase|order\s+it|get\s+it|want\s+it|checkout|check\s+out|"
    r"payment|pay\s+for|i'?ll\s+take)\b",
    re.I,
)


def route_by_regex(text: str) -> RouterDecision:
    """Layer 2 router: regex heuristics, sub-millisecond, no API calls."""
    t = text.strip()

    if _ISBN_RE.search(t):
        return RouterDecision(Intent.ISBN_SEARCH, 0.98, "regex")

    if _GREETING_RE.match(t) and len(t.split()) <= 6:
        return RouterDecision(Intent.GREETING, 0.95, "regex")

    if _CLOSING_RE.search(t) and not _ORDER_RE.search(t):
        return RouterDecision(Intent.CLOSING, 0.92, "regex")

    if _EMAIL_RE.search(t):
        return RouterDecision(Intent.EMAIL_CAPTURE, 0.93, "regex")

    if _FACILITY_RE.search(t):
        return RouterDecision(Intent.FACILITY_CHECK, 0.88, "regex")

    if _ORDER_RE.search(t):
        return RouterDecision(Intent.ORDER_LOOKUP, 0.88, "regex")

    if _BUY_RE.search(t):
        return RouterDecision(Intent.CHECKOUT, 0.86, "regex")

    if _BOOK_RE.search(t):
        return RouterDecision(Intent.PRODUCT_SEARCH, 0.85, "regex")

    return RouterDecision(Intent.GENERAL, 0.45, "regex")


async def route_by_llm(text: str, openai_client: "AsyncOpenAI") -> RouterDecision:
    """
    Layer 3 router: LLM fallback for low-confidence utterances.
    ~300ms, ~$0.0001 per call.
    """
    from ..config import get_settings
    settings = get_settings()

    response = await openai_client.chat.completions.create(
        model=settings.OPENAI_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "Classify this phone call utterance. "
                    "Reply with exactly one word from: "
                    "product_search, order_lookup, facility_check, "
                    "checkout, email_capture, closing, general"
                ),
            },
            {"role": "user", "content": text},
        ],
        temperature=0,
        max_tokens=10,
    )

    raw = (response.choices[0].message.content or "general").strip().lower()
    try:
        intent = Intent(raw)
    except ValueError:
        intent = Intent.GENERAL

    return RouterDecision(intent, 0.82, "llm")
