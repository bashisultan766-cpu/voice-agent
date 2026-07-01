"""Brain order tool results must use Shopify template speech, not LLM reformatting."""
from __future__ import annotations

from app.agent_runtime.order_parallel_enrichment import enforce_order_response
from app.state.models import SessionState


def _session() -> SessionState:
    return SessionState(
        session_id="enforce",
        call_sid="CAENF001",
        from_number="+1",
        to_number="+2",
    )


def test_enforce_order_response_uses_template_not_llm():
    session = _session()
    payload = {
        "found": True,
        "order": {
            "order_number": "#47905",
            "customer_name": "Jane Doe",
            "financial_status": "PAID",
            "fulfillment_status": "FULFILLED",
            "pricing": {
                "subtotal": "25.00",
                "shipping": "4.99",
                "total": "29.99",
            },
            "line_items": [{"title": "Test Book", "quantity": 1}],
        },
    }
    spoken = enforce_order_response(
        session,
        "LLM invented wrong totals and fake tracking.",
        [("lookup_shopify_order_details", payload)],
    )
    assert "LLM invented" not in spoken
    assert "found your order" in spoken.lower()
    assert session.order_last_voice_reply
    assert session.order_context
