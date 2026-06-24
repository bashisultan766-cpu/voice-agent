"""
ActiveCommerceState — durable per-call sales/commerce state (v4.17).

This is the single source of truth the LLM-first runtime uses to keep track of
the book the caller is currently looking at, the books they have selected, and
the cart they are building. It is persisted in Redis keyed by call_sid so it
survives across turns (and brief reconnects) and is never lost when the caller
asks for a second book.

Design goals:
  * current_candidate            — the book just found (not yet committed).
  * selected_candidates[]        — books the caller asked to keep but that have
                                   not yet been confirmed into the cart.
  * cart_lines[]                 — books committed to the order.
  * pending_action               — what a bare "yes" should do next.
  * last_full_isbn / last_selected_* — quick-reference last selection fields.

Persistence:
  * An in-process cache gives synchronous, single-process correctness within a
    call (used heavily in tests).
  * A best-effort write-through to Redis (cache_set) keyed by call_sid keeps the
    state durable. Failures are non-fatal.

Logging (no secrets, no PII):
  commerce_state_loaded sid=... current_candidate=... cart_lines=N
  commerce_state_saved  sid=... current_candidate=... cart_lines=N
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)

# In-process cache — single-process correctness within a call.
_STATES: dict[str, "ActiveCommerceState"] = {}

_STATE_TTL_SECS = 60 * 60  # 1 hour


@dataclass
class ActiveCommerceState:
    """Durable commerce state for one call."""

    sid: str
    current_candidate: Optional[dict[str, Any]] = None
    selected_candidates: list[dict[str, Any]] = field(default_factory=list)
    cart_lines: list[dict[str, Any]] = field(default_factory=list)
    pending_action: Optional[str] = None
    last_full_isbn: str = ""
    last_selected_product_id: str = ""
    last_selected_variant_id: str = ""
    last_selected_title: str = ""
    last_selected_price: str = ""

    # ── Derived helpers ──────────────────────────────────────────────────
    def cart_count(self) -> int:
        return len(self.cart_lines)

    def has_current_candidate(self) -> bool:
        return bool(self.current_candidate and self.current_candidate.get("title"))

    def current_title(self) -> str:
        return (self.current_candidate or {}).get("title", "") if self.current_candidate else ""

    def to_summary_dict(self) -> dict[str, Any]:
        """Safe, compact summary for LLM context / diagnostics (no PII)."""
        return {
            "current_candidate": self.current_title() or None,
            "selected_candidates": [c.get("title", "") for c in self.selected_candidates],
            "cart_lines": [c.get("title", "") for c in self.cart_lines],
            "cart_count": self.cart_count(),
            "pending_action": self.pending_action or "",
            "last_full_isbn": self.last_full_isbn,
            "last_selected_title": self.last_selected_title,
            "last_selected_price": self.last_selected_price,
        }


def _short_sid(sid: str) -> str:
    return sid[:6] if sid else "?"


def _candidate_label(state: ActiveCommerceState) -> str:
    title = state.current_title()
    return title[:40] if title else "none"


def _state_key(sid: str) -> str:
    return f"commerce_state:{sid}"


# ── Build a candidate dict from a Shopify product result ─────────────────────
def candidate_from_product(product: dict[str, Any], isbn: str = "") -> dict[str, Any]:
    """Normalise a Shopify search result row into a candidate dict."""
    variants = product.get("variants") or []
    variant_id = ""
    if variants and isinstance(variants[0], dict):
        variant_id = str(variants[0].get("id") or "")
    price = product.get("price") or ""
    if isinstance(price, str) and price and not price.startswith("$") and price != "N/A":
        # Normalise bare numeric prices to a phone-friendly "$X.XX".
        try:
            price = f"${float(price):.2f}"
        except (ValueError, TypeError):
            pass
    return {
        "title": product.get("title", "") or "",
        "isbn": isbn or product.get("isbn", "") or "",
        "product_id": str(product.get("id") or product.get("product_id") or ""),
        "variant_id": variant_id or str(product.get("variant_id") or ""),
        "price": price or "",
        "available": bool(product.get("available", True)),
        "author": product.get("author", "") or "",
    }


# ── Load / save ──────────────────────────────────────────────────────────────
def load_active_commerce_state(sid: str) -> ActiveCommerceState:
    """Load (or create) the active commerce state for a call. Logs the load."""
    state = _STATES.get(sid)
    if state is None:
        state = ActiveCommerceState(sid=sid)
        _STATES[sid] = state
    logger.info(
        "commerce_state_loaded sid=%s current_candidate=%s cart_lines=%d",
        _short_sid(sid),
        _candidate_label(state),
        state.cart_count(),
    )
    return state


def save_active_commerce_state(state: ActiveCommerceState) -> None:
    """Persist the active commerce state (in-process + best-effort Redis)."""
    _STATES[state.sid] = state
    logger.info(
        "commerce_state_saved sid=%s current_candidate=%s cart_lines=%d",
        _short_sid(state.sid),
        _candidate_label(state),
        state.cart_count(),
    )
    _schedule_redis_persist(state)


def clear_active_commerce_state(sid: str) -> None:
    _STATES.pop(sid, None)


# ── State mutations ──────────────────────────────────────────────────────────
def set_current_candidate(
    state: ActiveCommerceState, candidate: dict[str, Any]
) -> None:
    """Record the book just found as the current candidate."""
    state.current_candidate = dict(candidate)
    state.last_selected_title = candidate.get("title", "") or state.last_selected_title
    state.last_selected_price = candidate.get("price", "") or state.last_selected_price
    state.last_selected_product_id = (
        candidate.get("product_id", "") or state.last_selected_product_id
    )
    state.last_selected_variant_id = (
        candidate.get("variant_id", "") or state.last_selected_variant_id
    )
    if candidate.get("isbn"):
        state.last_full_isbn = candidate["isbn"]


def commit_current_to_cart(state: ActiveCommerceState) -> Optional[dict[str, Any]]:
    """Move the current candidate into the cart (deduped by variant/title)."""
    cand = state.current_candidate
    if not cand or not cand.get("title"):
        return None
    if not _already_in_cart(state, cand):
        state.cart_lines.append(dict(cand))
    state.current_candidate = None
    # Remove any matching entry from the pending selected list.
    state.selected_candidates = [
        c for c in state.selected_candidates if not _same_product(c, cand)
    ]
    return cand


def remember_current_as_selected(state: ActiveCommerceState) -> Optional[dict[str, Any]]:
    """Keep the current candidate as a pending selection (not yet in cart)."""
    cand = state.current_candidate
    if not cand or not cand.get("title"):
        return None
    if not any(_same_product(c, cand) for c in state.selected_candidates):
        state.selected_candidates.append(dict(cand))
    state.current_candidate = None
    return cand


def commit_all_to_cart(state: ActiveCommerceState) -> int:
    """Commit current candidate + all pending selections into the cart."""
    if state.current_candidate and state.current_candidate.get("title"):
        if not _already_in_cart(state, state.current_candidate):
            state.cart_lines.append(dict(state.current_candidate))
        state.current_candidate = None
    for cand in state.selected_candidates:
        if cand.get("title") and not _already_in_cart(state, cand):
            state.cart_lines.append(dict(cand))
    state.selected_candidates = []
    return state.cart_count()


def _same_product(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if a.get("variant_id") and b.get("variant_id"):
        return a["variant_id"] == b["variant_id"]
    if a.get("isbn") and b.get("isbn"):
        return a["isbn"] == b["isbn"]
    return (a.get("title", "").lower() == b.get("title", "").lower()) and bool(a.get("title"))


def _already_in_cart(state: ActiveCommerceState, cand: dict[str, Any]) -> bool:
    return any(_same_product(c, cand) for c in state.cart_lines)


# ── Best-effort Redis persistence ────────────────────────────────────────────
def _schedule_redis_persist(state: ActiveCommerceState) -> None:
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_persist_to_redis(state))


async def _persist_to_redis(state: ActiveCommerceState) -> None:
    try:
        from ..state.session_store import cache_set

        await cache_set(_state_key(state.sid), asdict(state), ttl=_STATE_TTL_SECS)
    except Exception as exc:  # noqa: BLE001 — persistence is best-effort
        logger.debug("commerce_state_persist_skipped sid=%s err=%s", _short_sid(state.sid), exc)


async def hydrate_active_commerce_state(sid: str) -> ActiveCommerceState:
    """Load state from Redis into the in-process cache (best-effort)."""
    if sid in _STATES:
        return _STATES[sid]
    try:
        from ..state.session_store import cache_get

        raw = await cache_get(_state_key(sid))
        if raw and isinstance(raw, dict):
            state = ActiveCommerceState(sid=sid)
            for key in ActiveCommerceState.__dataclass_fields__:
                if key in raw:
                    setattr(state, key, raw[key])
            _STATES[sid] = state
            return state
    except Exception as exc:  # noqa: BLE001
        logger.debug("commerce_state_hydrate_skipped sid=%s err=%s", _short_sid(sid), exc)
    return load_active_commerce_state(sid)
