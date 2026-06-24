"""
Caller identity at call start (v4.17).

Recognises returning callers by phone number so the first greeting can use the
caller's first name. Phone match is FRIENDLY RECOGNITION ONLY — it is never
treated as full verification, and no private details (email, address, order
contents) are revealed from caller-ID alone.

Lookup order (fast → slow), each step optional and failure-tolerant:
  1. Redis caller profile (sub-ms)            — caller/repository
  2. Redis Shopify customer cache by phone    — sync/repositories CustomerCache
  3. Live Shopify customers(query: "phone:")  — high-confidence E.164 match
  4. Live Shopify orders(query: "phone:")     — recent order association

Returns a customer-safe dict:
  {
    "known": bool,
    "customer_id": str,
    "first_name": str,
    "last_name": str,
    "phone_match_confidence": "high"|"medium"|"low",
    "recent_orders": [ {order_number, status, fulfillment_status} ],
    "allowed_greeting_name": str,   # safe first name to greet with, or ""
  }
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional, TYPE_CHECKING

from ..caller.repository import get_caller_profile, normalize_phone

if TYPE_CHECKING:
    from ..state.models import SessionState

logger = logging.getLogger(__name__)

_DIGITS = re.compile(r"\D")


def to_e164(raw: str, *, default_country_code: str = "1") -> str:
    """
    Normalise a phone number to E.164 (best-effort, US-default).

    "+1 (555) 123-4567" → "+15551234567"
    "5551234567"        → "+15551234567"
    Already-normalised   passthrough; returns "" for empty/garbage.
    """
    if not raw:
        return ""
    raw = raw.strip()
    had_plus = raw.startswith("+")
    digits = _DIGITS.sub("", raw)
    if not digits:
        return ""
    if had_plus:
        return "+" + digits
    if len(digits) == 10:  # US local number, prepend country code
        return f"+{default_country_code}{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return "+" + digits


def _empty_result() -> dict[str, Any]:
    return {
        "known": False,
        "customer_id": "",
        "first_name": "",
        "last_name": "",
        "phone_match_confidence": "low",
        "recent_orders": [],
        "allowed_greeting_name": "",
    }


def _first_name_from(display_name: str) -> str:
    return (display_name or "").strip().split(" ")[0] if display_name else ""


def _safe_order_summary(node: dict) -> dict[str, str]:
    """Customer-safe order summary — status only, never line items or totals."""
    return {
        "order_number": str(node.get("name") or "").strip(),
        "status": str(node.get("displayFinancialStatus") or "").strip(),
        "fulfillment_status": str(node.get("displayFulfillmentStatus") or "").strip(),
    }


async def _from_caller_profile(e164: str) -> Optional[dict[str, Any]]:
    try:
        profile = await get_caller_profile(e164)
    except Exception as exc:  # noqa: BLE001
        logger.debug("caller_profile lookup failed: %s", exc)
        return None
    if not profile:
        return None
    first = _first_name_from(getattr(profile, "display_name", ""))
    result = _empty_result()
    result.update(
        known=bool(first or getattr(profile, "shopify_customer_id", "")),
        customer_id=getattr(profile, "shopify_customer_id", "") or "",
        first_name=first,
        phone_match_confidence="high",
        allowed_greeting_name=first,
    )
    last_order = getattr(profile, "last_order_number", "")
    if last_order:
        result["recent_orders"] = [{"order_number": last_order, "status": "", "fulfillment_status": ""}]
    return result if result["known"] else None


async def _from_customer_cache(e164: str) -> Optional[dict[str, Any]]:
    try:
        from ..sync.repositories import CustomerCache

        cached = await CustomerCache().get_by_phone(e164)
    except Exception as exc:  # noqa: BLE001
        logger.debug("customer_cache lookup failed: %s", exc)
        return None
    if not cached:
        return None
    first = _first_name_from(getattr(cached, "display_name", ""))
    if not first and not getattr(cached, "customer_id", ""):
        return None
    result = _empty_result()
    result.update(
        known=True,
        customer_id=getattr(cached, "customer_id", "") or "",
        first_name=first,
        phone_match_confidence="high",
        allowed_greeting_name=first,
    )
    if getattr(cached, "last_order_number", ""):
        result["recent_orders"] = [
            {"order_number": cached.last_order_number, "status": "", "fulfillment_status": ""}
        ]
    return result


async def _from_live_shopify(e164: str, raw_phone: str) -> Optional[dict[str, Any]]:
    try:
        from ..shopify.client import get_shopify_client
        from ..shopify.graphql_queries import SEARCH_CUSTOMERS

        client = get_shopify_client()
        if not client.configured:
            return None

        # Try E.164 then the raw digits — Shopify stores phone in varied formats.
        digits = _DIGITS.sub("", raw_phone or e164)
        queries = [f"phone:{e164}"]
        if digits and digits not in e164:
            queries.append(f"phone:{digits}")

        for q in queries:
            data = await client.execute(SEARCH_CUSTOMERS, variables={"query": q, "first": 3})
            edges = data.get("data", {}).get("customers", {}).get("edges", [])
            if not edges:
                continue
            node = edges[0]["node"]
            first = (node.get("firstName") or "").strip()
            last = (node.get("lastName") or "").strip()
            stored_phone = _DIGITS.sub("", node.get("phone") or "")
            confidence = "high" if stored_phone and stored_phone in (digits, e164.lstrip("+")) else "medium"
            orders = [
                _safe_order_summary(e["node"])
                for e in node.get("orders", {}).get("edges", [])
            ]
            result = _empty_result()
            result.update(
                known=True,
                customer_id=node.get("id", "") or "",
                first_name=first,
                last_name=last,
                phone_match_confidence=confidence,
                recent_orders=orders,
                allowed_greeting_name=first,
            )
            return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("live shopify caller lookup failed: %s", type(exc).__name__)
    return None


async def get_caller_info(
    phone_number: str,
    *,
    allow_live: bool = True,
) -> dict[str, Any]:
    """
    Resolve caller identity from phone number (cache-first, then live Shopify).

    Always returns a safe dict (never raises). ``allow_live`` lets the live
    Shopify lookups be disabled for the latency-critical first greeting.
    """
    e164 = to_e164(phone_number)
    if not e164:
        logger.info("caller_identity_lookup result=no_phone")
        return _empty_result()

    masked = e164[:5] + "***"

    for step, fn in (
        ("caller_profile", _from_caller_profile),
        ("customer_cache", _from_customer_cache),
    ):
        result = await fn(e164)
        if result and result.get("known"):
            logger.info(
                "caller_identity_lookup phone=%s source=%s known=true confidence=%s",
                masked, step, result["phone_match_confidence"],
            )
            return result

    if allow_live:
        result = await _from_live_shopify(e164, phone_number)
        if result and result.get("known"):
            logger.info(
                "caller_identity_lookup phone=%s source=live_shopify known=true confidence=%s orders=%d",
                masked, result["phone_match_confidence"], len(result["recent_orders"]),
            )
            return result

    logger.info("caller_identity_lookup phone=%s known=false", masked)
    return _empty_result()


def apply_to_session(session: "SessionState", info: dict[str, Any]) -> None:
    """
    Store safe caller-identity fields on the session before the first LLM turn.

    Only friendly-recognition fields are written; nothing here counts as
    verification (verified_email / verified_phone are NOT set from phone match).
    """
    if not info or not info.get("known"):
        return
    name = info.get("allowed_greeting_name") or info.get("first_name") or ""
    if name and not getattr(session, "caller_name", ""):
        session.caller_name = name
    session.is_returning_caller = True
    if info.get("customer_id") and not getattr(session, "shopify_customer_id", ""):
        try:
            session.shopify_customer_id = info["customer_id"]
        except Exception:  # noqa: BLE001 — session may not declare the attr
            pass
    orders = info.get("recent_orders") or []
    if orders and not getattr(session, "last_order_number", ""):
        try:
            session.last_order_number = orders[0].get("order_number", "") or ""
        except Exception:  # noqa: BLE001
            pass


def build_greeting(info: dict[str, Any], *, late: bool = False) -> str:
    """
    Build a recognition greeting.

    Known caller (fast):   "Hi Berlin, thanks for calling SureShot Books. How can I help today?"
    Known caller (late):   "By the way, I found your profile, Berlin — how can I help?"
    Unknown caller:        generic SureShot greeting.
    """
    name = (info or {}).get("allowed_greeting_name", "").strip() if info else ""
    if name:
        if late:
            return f"By the way, I found your profile, {name} — how can I help?"
        return f"Hi {name}, thanks for calling SureShot Books. How can I help today?"
    return "Thank you for calling SureShot Books. How can I help you today?"
