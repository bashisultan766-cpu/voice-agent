"""v4.14.7 — Commerce context fallback tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.business_intent_resolver import (
    ANSWER_GENERIC_REPEAT,
    context_aware_unknown_fallback,
)
from app.agent_runtime.commerce_session import (
    CartLine,
    ProductCandidate,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.tool_answer_composer import _format_single_product
from app.agent_runtime.cart_orchestrator import add_candidate_to_cart
from app.state.models import SessionState


def _state(sid: str = "CAcartfb") -> SessionState:
    return SessionState(
        session_id=f"sess{sid}",
        call_sid=sid,
        from_number="+15551234567",
        to_number="+15559876543",
    )


class TestCommerceContextFallback:
    def test_cart_lines_no_generic_unknown(self):
        sid = "CAcartfb1"
        clear_commerce_session(sid)
        cs = get_commerce_session(sid)
        cs.active_cart = [
            CartLine(
                line_id="l1",
                product_id="p1",
                variant_id="v1",
                title="Item One",
                isbn=None,
                price="$10",
                quantity=1,
                destination_group_id=None,
                status="active",
            )
        ] * 5
        fb = context_aware_unknown_fallback("uh huh", session_state=_state(sid), sid=sid)
        assert ANSWER_GENERIC_REPEAT not in fb.get("direct_answer", "")
        assert "cart" in fb.get("direct_answer", "").lower()

    def test_candidates_no_generic_unknown(self):
        sid = "CAcartfb2"
        clear_commerce_session(sid)
        cs = get_commerce_session(sid)
        update_candidates_from_facts(cs, [
            ProductCandidate(
                candidate_id="c1",
                product_id="p1",
                variant_id="v1",
                title="USA Today",
                author=None,
                isbn=None,
                price="$149.99",
                currency="USD",
                availability="available",
                inventory_quantity=1,
                source="catalog",
                confidence=0.9,
                product_kind="newspaper",
            ),
            ProductCandidate(
                candidate_id="c2",
                product_id="p2",
                variant_id="v2",
                title="Other Paper",
                author=None,
                isbn=None,
                price="$99",
                currency="USD",
                availability="available",
                inventory_quantity=1,
                source="catalog",
                confidence=0.8,
                product_kind="newspaper",
            ),
        ])
        fb = context_aware_unknown_fallback("mm-hmm", session_state=_state(sid), sid=sid)
        assert ANSWER_GENERIC_REPEAT not in fb.get("direct_answer", "")

    def test_newspaper_add_to_cart_message(self):
        msg = _format_single_product({
            "title": "USA Today 5 Day",
            "price": "$149.99",
            "product_kind": "newspaper",
            "out_of_stock": False,
        })
        assert "newspaper" in msg.lower()

    def test_newspaper_candidate_cart_add(self):
        sid = "CAcartfb3"
        clear_commerce_session(sid)
        cs = get_commerce_session(sid)
        update_candidates_from_facts(cs, [
            ProductCandidate(
                candidate_id="np1",
                product_id="p99",
                variant_id="v99",
                title="USA Today 5 Day",
                author=None,
                isbn=None,
                price="$149.99",
                currency="USD",
                availability="available",
                inventory_quantity=5,
                source="catalog",
                confidence=0.95,
                product_kind="newspaper",
            ),
        ])
        cs.selected_candidate_id = "np1"
        result = add_candidate_to_cart(cs, "np1", session_state=_state(sid))
        assert result.get("success")
