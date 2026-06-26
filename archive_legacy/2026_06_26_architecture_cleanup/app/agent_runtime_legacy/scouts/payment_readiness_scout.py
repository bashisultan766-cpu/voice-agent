"""Payment readiness scout — read-only checkout prerequisites (v4.16.0)."""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from ..speculative_prefetch_manager import PrefetchResult

if TYPE_CHECKING:
    from ..commerce_session import CommerceSession


async def run_scout(
    *,
    commerce_session: "CommerceSession | None" = None,
    call_sid: str = "",
    **_,
) -> PrefetchResult | None:
    from ..cart_orchestrator import cart_count

    count = cart_count(commerce_session) if commerce_session else 0
    has_cart = count > 0
    confirmed_email = False
    if commerce_session is not None:
        confirmed_email = bool(getattr(commerce_session, "confirmed_email", ""))
    facts = {
        "has_cart": has_cart,
        "cart_count": count,
        "confirmed_email": confirmed_email,
        "ready_for_checkout": has_cart and confirmed_email,
    }
    return PrefetchResult(
        result_id=str(uuid.uuid4())[:12],
        scout_name="payment_readiness_scout",
        kind="payment_readiness",
        confidence=1.0,
        entities={"has_cart": has_cart, "confirmed_email": confirmed_email},
        facts=facts,
        source="payment_readiness_scout",
        safe_for_llm=True,
        requires_live_verification=True,
    )
