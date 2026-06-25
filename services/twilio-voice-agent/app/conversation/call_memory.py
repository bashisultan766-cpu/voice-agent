"""
Call memory — 50-turn working memory for live voice (v4.6).

Stores safe user/assistant turns, rolling summary, and key facts.
Never stores role=tool or OpenAI tool calls.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_MAX_TURNS = 50
_VERBATIM_TURNS = 12
_FORBIDDEN_ROLES = frozenset({"tool", "function"})
_SESSION_SNAPSHOT_TTL = 60 * 60 * 24  # 24 hours


@dataclass
class CallMemoryState:
    user_turns: list[str] = field(default_factory=list)
    assistant_turns: list[str] = field(default_factory=list)
    rolling_summary: str = ""
    important_facts: list[str] = field(default_factory=list)
    cart_facts: list[str] = field(default_factory=list)
    isbns_provided: list[str] = field(default_factory=list)
    email_state: str = "none"
    order_context: str = ""
    refund_context: str = ""
    facility_context: str = ""
    current_topic: str = ""
    customer_mood: str = "normal"


def get_call_memory(session: "SessionState") -> CallMemoryState:
    raw = getattr(session, "call_memory", None)
    if isinstance(raw, CallMemoryState):
        return raw
    if isinstance(raw, dict):
        state = CallMemoryState()
        for key in CallMemoryState.__dataclass_fields__:
            if key in raw:
                setattr(state, key, raw[key])
        session.call_memory = state
        return state
    state = CallMemoryState()
    session.call_memory = state
    return state


def _mask_for_log(text: str) -> str:
    if not text:
        return ""
    masked = re.sub(
        r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}",
        "***@***",
        text,
        flags=re.IGNORECASE,
    )
    if len(masked) > 80:
        return masked[:77] + "..."
    return masked


def _trim_turns(turns: list[str]) -> list[str]:
    if len(turns) > _MAX_TURNS:
        return turns[-_MAX_TURNS:]
    return turns


def _append_fact(state: CallMemoryState, fact: str) -> None:
    if fact and fact not in state.important_facts:
        state.important_facts.append(fact)
    if len(state.important_facts) > 40:
        state.important_facts = state.important_facts[-40:]


def _rebuild_rolling_summary(state: CallMemoryState) -> None:
    """Compress older turns beyond verbatim window into a short summary."""
    total = len(state.user_turns)
    if total <= _VERBATIM_TURNS:
        return

    older_user = state.user_turns[: total - _VERBATIM_TURNS]
    older_assistant = state.assistant_turns[: max(0, len(state.assistant_turns) - _VERBATIM_TURNS)]

    snippets: list[str] = []
    for i, ut in enumerate(older_user[-10:]):
        snippets.append(f"Customer: {_mask_for_log(ut)}")
        if i < len(older_assistant):
            snippets.append(f"Agent: {_mask_for_log(older_assistant[i])}")

    if state.important_facts:
        snippets.append("Facts: " + "; ".join(state.important_facts[-8:]))

    state.rolling_summary = " | ".join(snippets)[:1200]


def record_user_turn(session: "SessionState", text: str, intent: str = "") -> None:
    if not text or not text.strip():
        return
    state = get_call_memory(session)
    state.user_turns = _trim_turns(state.user_turns + [text.strip()])

    if intent:
        state.current_topic = intent.replace("_", " ")

    mood = getattr(getattr(session, "dialogue", None), "customer_mood", "")
    if mood:
        state.customer_mood = mood

    _rebuild_rolling_summary(state)
    logger.debug(
        "call_memory user_turn sid=%s count=%d topic=%s",
        session.call_sid[:6],
        len(state.user_turns),
        _mask_for_log(state.current_topic),
    )


def record_assistant_turn(session: "SessionState", text: str) -> None:
    if not text or not text.strip():
        return
    state = get_call_memory(session)
    state.assistant_turns = _trim_turns(state.assistant_turns + [text.strip()])
    _rebuild_rolling_summary(state)


def record_isbn(session: "SessionState", isbn: str) -> None:
    state = get_call_memory(session)
    if isbn and isbn not in state.isbns_provided:
        state.isbns_provided.append(isbn)
        _append_fact(state, f"Customer gave ISBN {isbn}")
        logger.info(
            "memory_fact_saved sid=%s type=isbn",
            session.call_sid[:6],
        )


def record_product_candidate(session: "SessionState", title: str, found: bool) -> None:
    state = get_call_memory(session)
    if found and title:
        _append_fact(state, f"Product candidate found: {title[:60]}")
    elif not found:
        _append_fact(state, "Product candidate not found")


def record_cart_confirmed(session: "SessionState", title: str, count: int) -> None:
    state = get_call_memory(session)
    state.cart_facts.append(f"Confirmed: {title[:50]}")
    _append_fact(state, f"Cart count: {count}")
    logger.info(
        "memory_fact_saved sid=%s type=cart count=%d",
        session.call_sid[:6], count,
    )


def sync_email_state(session: "SessionState") -> None:
    state = get_call_memory(session)
    confirmed = getattr(session, "confirmed_email", "") or ""
    pending = getattr(session, "pending_email", "") or ""
    rejected = getattr(session, "email_rejected_count", 0) or 0

    if confirmed:
        state.email_state = "confirmed"
        _append_fact(state, "Customer confirmed email")
        logger.info("memory_fact_saved sid=%s type=email state=confirmed", session.call_sid[:6])
    elif pending:
        state.email_state = "pending"
        _append_fact(state, "Customer provided email")
        logger.info("memory_fact_saved sid=%s type=email state=pending", session.call_sid[:6])
    elif rejected:
        state.email_state = "rejected"
        _append_fact(state, "Email rejected or corrected")


def sync_payment_state(session: "SessionState") -> None:
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    state = get_call_memory(session)
    if pfs != "idle":
        _append_fact(state, f"Payment status: {pfs}")

    pfr = getattr(session, "payment_flow_result", {}) or {}
    if pfr.get("email_sent"):
        _append_fact(state, "Payment link sent")
        logger.info("memory_fact_saved sid=%s type=payment sent=true", session.call_sid[:6])


def sync_facility_context(session: "SessionState") -> None:
    name = getattr(session, "last_facility_name", "") or ""
    if name:
        state = get_call_memory(session)
        state.facility_context = name[:60]
        _append_fact(state, f"Facility mentioned: {name[:40]}")


def sync_from_session(session: "SessionState") -> None:
    """Refresh facts from session state after workers run."""
    state = get_call_memory(session)

    for isbn in getattr(session, "isbn_history", []) or []:
        if isbn not in state.isbns_provided:
            state.isbns_provided.append(isbn)

    try:
        from ..cart.session import get_ledger
        ledger = get_ledger(session)
        n = ledger.confirmed_count()
        if n:
            state.cart_facts = [f"{n} book(s) in cart"]
            _append_fact(state, f"Cart count: {n}")
    except Exception:
        pass

    if session.last_order_number:
        state.order_context = session.last_order_number
        _append_fact(state, f"Order number: {session.last_order_number}")

    sync_email_state(session)
    sync_payment_state(session)
    sync_facility_context(session)

    dialogue = getattr(session, "dialogue", None)
    if dialogue:
        topic = getattr(dialogue, "current_topic", "") or getattr(dialogue, "active_flow", "")
        if topic:
            state.current_topic = str(topic)


def build_composer_context(session: "SessionState") -> str:
    """Compact memory block for MainLLMComposer."""
    state = get_call_memory(session)
    parts: list[str] = []

    if state.rolling_summary:
        parts.append(f"[Earlier call summary: {state.rolling_summary}]")

    recent_users = state.user_turns[-_VERBATIM_TURNS:]
    recent_assistants = state.assistant_turns[-_VERBATIM_TURNS:]
    for i, ut in enumerate(recent_users):
        parts.append(f"[Turn user: {ut[:200]}]")
        if i < len(recent_assistants):
            parts.append(f"[Turn agent: {recent_assistants[i][:200]}]")

    if state.important_facts:
        parts.append("[Key facts: " + "; ".join(state.important_facts[-12:]) + "]")

    if state.isbns_provided:
        parts.append(f"[ISBNs remembered: {', '.join(state.isbns_provided[-10:])}]")

    if state.cart_facts:
        parts.append("[Cart: " + "; ".join(state.cart_facts[-5:]) + "]")

    if state.email_state != "none":
        parts.append(f"[Email state: {state.email_state}]")

    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    if pfs != "idle":
        parts.append(f"[Payment: {pfs}]")

    if state.facility_context:
        parts.append(f"[Facility: {state.facility_context}]")

    if state.current_topic:
        parts.append(f"[Topic: {state.current_topic}]")

    if state.customer_mood != "normal":
        parts.append(f"[Mood: {state.customer_mood}]")

    return "\n".join(parts)


def build_brain_context(session: "SessionState") -> str:
    """Memory block for EricDialogueBrain planner."""
    state = get_call_memory(session)
    parts: list[str] = ["[Call memory]"]

    if state.rolling_summary:
        parts.append(f"Summary: {state.rolling_summary[:600]}")

    recent_users = state.user_turns[-12:]
    recent_assistants = state.assistant_turns[-12:]
    for i, ut in enumerate(recent_users):
        parts.append(f"User: {_mask_for_log(ut)}")
        if i < len(recent_assistants):
            parts.append(f"Agent: {_mask_for_log(recent_assistants[i])}")

    if state.important_facts:
        parts.append("Facts: " + "; ".join(state.important_facts[-15:]))

    if state.isbns_provided:
        parts.append(f"ISBNs: {', '.join(state.isbns_provided[-10:])}")

    if state.cart_facts:
        parts.append("Cart: " + "; ".join(state.cart_facts[-5:]))

    if state.email_state != "none":
        parts.append(f"Email: {state.email_state}")

    if getattr(session, "is_resumed_call", False):
        parts.append("Call was resumed after disconnect")

    if getattr(session, "resume_greeting_delivered", False):
        parts.append("Resume apology already delivered")

    n_facts = len(state.important_facts)
    logger.debug(
        "memory_context_used sid=%s facts=%d",
        session.call_sid[:6], n_facts,
    )
    return "\n".join(parts)


_SALES_FACT_TEMPLATES = {
    "selected_product": "Selected book: {detail}",
    "current_candidate": "Current book: {detail}",
    "cart_line": "Added to order: {detail}",
    "isbn": "ISBN: {detail}",
    "pending_action": "Pending action: {detail}",
    "another_book": "Customer wants another book",
    "price_target": "Price asked for: {detail}",
}


def record_sales_fact(
    session: "SessionState",
    fact_type: str,
    detail: str = "",
) -> None:
    """
    Record a durable sales fact (selected product, cart line, ISBN, pending
    action, another-book request, price target) and log it.

    Facts increase after product selection and add decisions so the memory
    packet reflects what the caller is buying.
    """
    state = get_call_memory(session)
    template = _SALES_FACT_TEMPLATES.get(fact_type, "{detail}")
    fact = template.format(detail=(detail or "").strip()[:60]).strip()
    if fact:
        _append_fact(state, fact)
    logger.info(
        "memory_fact_extracted sid=%s type=%s",
        getattr(session, "call_sid", "")[:6],
        fact_type,
    )


def record_brain_fact(session: "SessionState", intent: str) -> None:
    """Extract important fact after brain decision."""
    if not intent or intent == "unknown":
        return
    state = get_call_memory(session)
    fact = f"Brain intent: {intent.replace('_', ' ')}"
    _append_fact(state, fact)

    if intent in ("frustration_repair",):
        state.customer_mood = "frustrated"
        _append_fact(state, "Caller frustration detected")
        logger.info("memory_fact_saved sid=%s type=frustration", session.call_sid[:6])

    if intent in ("send_payment_link", "payment_execute"):
        logger.info("memory_fact_saved sid=%s type=payment intent=%s", session.call_sid[:6], intent)

    if intent in ("facility_approval_question", "facility_approval"):
        logger.info("memory_fact_saved sid=%s type=facility", session.call_sid[:6])


_NAME_PAT = re.compile(
    r"\b(?:my name is|this is|i am|i'm|it's|name's|call me)\s+"
    r"([A-Z][a-zA-Z'\-]{1,20})(?:\s+([A-Z][a-zA-Z'\-]{1,20}))?",
    re.IGNORECASE,
)
_NAME_STOPWORDS = frozenset({
    "looking", "trying", "calling", "wondering", "not", "sorry", "good", "fine",
    "okay", "ok", "here", "interested", "just", "actually", "still", "going",
    "the", "a", "an", "yes", "no", "done", "ready", "back",
})
_EMAIL_PAT = re.compile(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", re.IGNORECASE)
_QTY_PAT = re.compile(
    r"\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s+"
    r"(?:cop(?:y|ies)|books?|of them|of these|of those)\b",
    re.IGNORECASE,
)
_ORDER_PAT = re.compile(
    r"(?:order\s*(?:number|no\.?|#)?\s*(?:is|:)?\s*#?|#)\s*(\d{3,})",
    re.IGNORECASE,
)
_FACILITY_PAT = re.compile(
    r"\b(facility|inmate|prison|correctional|jail|detention|institution|"
    r"booking number|inmate number|cell block|unit)\b",
    re.IGNORECASE,
)
_PAYMENT_PAT = re.compile(
    r"\b(payment link|send (?:me )?the link|pay(?:ment)? by (?:email|link)|checkout link)\b",
    re.IGNORECASE,
)
_WORD_NUM = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
}


def extract_durable_facts(session: "SessionState", caller_text: str) -> int:
    """
    Extract durable, customer-safe facts from a single caller utterance.

    Returns the number of new facts recorded. Never stores raw email/phone in
    plaintext facts (email is recorded as a flag; ISBNs are non-PII).
    """
    text = (caller_text or "").strip()
    if not text:
        return 0
    state = get_call_memory(session)
    before = len(state.important_facts)

    # Caller name
    m = _NAME_PAT.search(text)
    if m:
        first = m.group(1)
        if first and first.lower() not in _NAME_STOPWORDS:
            name = first
            if m.group(2) and m.group(2).lower() not in _NAME_STOPWORDS:
                name = f"{first} {m.group(2)}"
            _append_fact(state, f"Caller name: {name}")
            if not getattr(session, "caller_name", ""):
                try:
                    session.caller_name = name[:100]
                except Exception:  # noqa: BLE001
                    pass

    # Preferred email (flag only — never store the address in a fact)
    if _EMAIL_PAT.search(text):
        _append_fact(state, "Caller provided an email address")
        logger.info("memory_fact_saved sid=%s type=email_mentioned", session.call_sid[:6])

    # ISBNs mentioned (checksum-validated only — no fragments)
    try:
        from ..tools.isbn import extract_isbn_candidate

        isbn = extract_isbn_candidate(text)
        if isbn:
            record_isbn(session, isbn)
    except Exception:  # noqa: BLE001
        pass

    # Quantity
    qm = _QTY_PAT.search(text)
    if qm:
        qty = _WORD_NUM.get(qm.group(1).lower(), qm.group(1))
        _append_fact(state, f"Quantity: {qty}")

    # Order number
    om = _ORDER_PAT.search(text)
    if om:
        _append_fact(state, f"Order number mentioned: {om.group(1)}")

    # Facility / inmate context
    if _FACILITY_PAT.search(text):
        _append_fact(state, "Facility/inmate context mentioned")

    # Payment link intent
    if _PAYMENT_PAT.search(text):
        _append_fact(state, "Payment link requested")

    new_count = len(state.important_facts) - before
    if new_count > 0:
        logger.info(
            "durable_facts_extracted sid=%s new=%d total=%d",
            session.call_sid[:6], new_count, len(state.important_facts),
        )
    return new_count


def extract_turn_facts(
    session: "SessionState",
    intent: str,
    caller_text: str,
) -> None:
    """Extract important facts after every turn."""
    state = get_call_memory(session)
    sync_from_session(session)

    # Durable, content-derived facts (name, email, ISBN, quantity, order, ...).
    extract_durable_facts(session, caller_text)

    lower = (caller_text or "").lower()
    if "already told" in lower or "i gave you" in lower:
        _append_fact(state, "Caller says they already provided info")
        state.customer_mood = "frustrated"

    if intent == "memory_summary_question":
        _append_fact(state, "Caller asked what was collected")

    if getattr(session, "last_order_number", ""):
        _append_fact(state, f"Order number: {session.last_order_number}")

    if getattr(session, "caller_name", ""):
        _append_fact(state, f"Caller name: {session.caller_name}")

    mood = getattr(getattr(session, "dialogue", None), "customer_mood", "")
    if mood == "frustrated":
        state.customer_mood = "frustrated"
        _append_fact(state, "Caller frustration noted")


def build_memory_snapshot(session: "SessionState") -> dict:
    """Safe, inspectable snapshot of working memory (no raw PII)."""
    state = get_call_memory(session)
    return {
        "call_sid": getattr(session, "call_sid", ""),
        "turn_count": len(state.user_turns),
        "assistant_turns": len(state.assistant_turns),
        "facts": list(state.important_facts[-40:]),
        "facts_count": len(state.important_facts),
        "isbns": list(state.isbns_provided[-10:]),
        "cart_facts": list(state.cart_facts[-5:]),
        "email_state": state.email_state,
        "order_context": state.order_context,
        "facility_context": state.facility_context,
        "current_topic": state.current_topic,
        "customer_mood": state.customer_mood,
        "caller_name": getattr(session, "caller_name", ""),
        "payment_flow_status": getattr(session, "payment_flow_status", "idle") or "idle",
        "rolling_summary": state.rolling_summary[:600],
    }


def memory_snapshot_key(call_sid: str) -> str:
    return f"caller:memory:{call_sid}"


async def persist_call_memory(session: "SessionState") -> None:
    """Best-effort persist of the working-memory snapshot for diagnostics."""
    from ..state.session_store import cache_set

    sid = getattr(session, "call_sid", "")
    if not sid:
        return
    try:
        await cache_set(memory_snapshot_key(sid), build_memory_snapshot(session), ttl=_SESSION_SNAPSHOT_TTL)
    except Exception as exc:  # noqa: BLE001
        logger.debug("persist_call_memory skipped: %s", exc)


def schedule_persist_call_memory(session: "SessionState") -> None:
    """Schedule snapshot persistence without blocking the turn (if loop running)."""
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(persist_call_memory(session))


async def load_call_memory_snapshot(call_sid: str) -> Optional[dict]:
    from ..state.session_store import cache_get

    if not call_sid:
        return None
    return await cache_get(memory_snapshot_key(call_sid))


def safe_history_append(session: "SessionState", role: str, content: str) -> None:
    """Append to session.history only for safe roles (no tool)."""
    if role in _FORBIDDEN_ROLES:
        return
    if "tool_calls" in (content or ""):
        return
    session.history.append({"role": role, "content": content})


# ── Call cutoff / resume support (v4.8) ─────────────────────────────────────

def build_resume_snapshot(session: "SessionState") -> dict:
    """
    Build a safe, minimal snapshot of the session for reconnect-within-window.

    Never includes full email, phone, card data, or raw history.
    """
    state = get_call_memory(session)
    pfs = getattr(session, "payment_flow_status", "idle") or "idle"
    return {
        "cart_count": len([
            i for i in (getattr(session, "cart_items", []) or [])
            if isinstance(i, dict) and i.get("confirmation_status") == "confirmed"
        ]),
        "cart_items": [
            {
                "title": i.get("title", ""),
                "isbn": i.get("isbn", ""),
                "variant_id": i.get("variant_id", ""),
                "quantity": int(i.get("quantity") or 1),
                "price": i.get("price", ""),
                "confirmation_status": i.get("confirmation_status", ""),
            }
            for i in (getattr(session, "cart_items", []) or [])
            if isinstance(i, dict) and i.get("confirmation_status") == "confirmed"
        ],
        "payment_flow_status": pfs,
        "has_checkout_url": bool(getattr(session, "pending_checkout_url", "")),
        "email_state": state.email_state,
        "last_order_number": getattr(session, "last_order_number", ""),
        "facility_context": state.facility_context,
        "current_topic": state.current_topic,
        "important_facts": state.important_facts[-5:],
        "isbn_count": len(state.isbns_provided),
    }


def store_resume_snapshot(session: "SessionState") -> None:
    """Store a safe resume snapshot on the session before disconnect."""
    import time
    snapshot = build_resume_snapshot(session)
    session.call_resume_snapshot = snapshot
    session.call_ended_at = time.time()
    logger.debug(
        "call_resume_snapshot stored sid=%s cart=%d topic=%s",
        session.call_sid[:6],
        snapshot.get("cart_count", 0),
        snapshot.get("current_topic", ""),
    )


def apply_resume_from_stored_data(
    new_session: "SessionState",
    stored: dict,
    resume_window_minutes: int = 30,
) -> bool:
    """
    Apply resume context from a persisted snapshot dict (Redis/in-memory).

    stored keys: call_sid, call_ended_at, snapshot
    """
    if not stored:
        return False

    class _PriorStub:
        pass

    prior = _PriorStub()
    prior.call_sid = stored.get("call_sid", "prior")
    prior.call_ended_at = stored.get("call_ended_at", 0.0)
    prior.call_resume_snapshot = stored.get("snapshot", {}) or {}
    prior.call_memory = None
    return check_and_apply_resume(new_session, prior, resume_window_minutes)


def check_and_apply_resume(
    new_session: "SessionState",
    prior_session: "SessionState",
    resume_window_minutes: int = 30,
) -> bool:
    """
    If prior_session ended recently (within window), copy safe context to new_session.

    Returns True if resume was applied; False otherwise.
    Never copies PII beyond what is explicitly safe.
    """
    import time
    ended = getattr(prior_session, "call_ended_at", 0.0) or 0.0
    if ended <= 0:
        return False
    age_minutes = (time.time() - ended) / 60.0
    if age_minutes > resume_window_minutes:
        return False

    snapshot = getattr(prior_session, "call_resume_snapshot", {}) or {}
    if not snapshot:
        return False

    state = get_call_memory(new_session)
    state.current_topic = snapshot.get("current_topic", "")
    state.facility_context = snapshot.get("facility_context", "")
    for fact in snapshot.get("important_facts", []):
        _append_fact(state, fact)

    if snapshot.get("payment_flow_status") not in ("idle", "", None):
        new_session.payment_flow_status = snapshot["payment_flow_status"]

    if snapshot.get("last_order_number"):
        new_session.last_order_number = snapshot["last_order_number"]

    cart_restore = snapshot.get("cart_items") or []
    if cart_restore:
        new_session.cart_items = list(cart_restore)
        from ..payment.payment_destination_groups import refresh_payment_groups_from_cart

        refresh_payment_groups_from_cart(new_session)
        logger.info(
            "call_resume_cart_restored sid=%s lines=%d",
            new_session.call_sid[:6],
            len(cart_restore),
        )

    new_session.is_resumed_call = True
    new_session.resume_greeting_pending = True
    new_session.resume_context_available = True
    new_session.resume_greeting_delivered = False
    logger.info(
        "call_resume_applied sid=%s prior_sid=%s age_min=%.1f",
        new_session.call_sid[:6],
        prior_session.call_sid[:6],
        age_minutes,
    )
    return True


def get_resume_greeting() -> str:
    """Return the standard dropped-call resume greeting."""
    return "I'm sorry about that. Let me continue from where we left off."
