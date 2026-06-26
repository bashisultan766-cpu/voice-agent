"""v4.14.8 — Orderability guard tests."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime.cart_orchestrator import add_candidate_to_cart
from app.agent_runtime.commerce_session import (
    ProductCandidate,
    clear_commerce_session,
    get_commerce_session,
    update_candidates_from_facts,
)
from app.agent_runtime.tool_answer_composer import _format_non_orderable
from app.state.models import SessionState


def _candidate(**kwargs) -> ProductCandidate:
    defaults = dict(
        candidate_id="c1",
        product_id="p1",
        variant_id="v1",
        title="USA Today",
        author=None,
        isbn=None,
        price="$149.99",
        currency="USD",
        availability="not_available_for_checkout",
        inventory_quantity=0,
        source="catalog",
        confidence=0.9,
        product_kind="newspaper",
        status="DRAFT",
        can_add_to_cart=False,
        unavailable_reason="not checkout-ready",
        checkout_variant_valid=True,
    )
    defaults.update(kwargs)
    return ProductCandidate(**defaults)


class TestOrderabilityGuards:
    def test_blocks_draft_add_to_cart(self):
        sid = "CAord1"
        clear_commerce_session(sid)
        cs = get_commerce_session(sid)
        update_candidates_from_facts(cs, [_candidate()])
        cs.selected_candidate_id = "c1"
        result = add_candidate_to_cart(cs, "c1")
        assert result["success"] is False
        assert "checkout" in result["message"].lower()

    def test_composer_non_orderable_message(self):
        msg = _format_non_orderable({"title": "USA Today", "publication_title": "USA Today"})
        assert "store data" in msg.lower()
        assert "customer service" in msg.lower()

    def test_caller_price_not_trusted(self):
        from app.agent_runtime.business_intent_resolver import (
            ANSWER_CALLER_PRICE_VERIFY,
            resolve_business_intent,
        )
        from app.state.models import SessionState

        state = SessionState(session_id="s1", call_sid="CAprice", from_number="+1", to_number="+2")
        state.dialogue.expected_next = "publication_title"
        biz = resolve_business_intent("It's $149.99.", session_state=state)
        assert "verify" in (biz.direct_answer or "").lower()
        assert ANSWER_CALLER_PRICE_VERIFY in (biz.direct_answer or "")

    def test_website_claim_no_api_message(self):
        from app.agent_runtime.business_intent_resolver import resolve_business_intent

        biz = resolve_business_intent("I can see it on your website")
        assert "store data" in (biz.direct_answer or "").lower()
