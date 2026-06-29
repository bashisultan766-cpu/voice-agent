"""CA4767 — order information without order number must not hallucinate lookup."""
from __future__ import annotations

import json

import pytest

from app.agent_runtime.llm_tools import dispatch
from app.agent_runtime.order_flow_state import (
    caller_verified_order_number,
    order_intent_detected,
    try_order_collection_short_circuit,
)
from app.agent_runtime.tool_runtime_gates import gate_order_lookup_tool
from app.agent_runtime.workflow_isolation import order_handling_allowed
from app.state.models import SessionState


def _session(**kwargs) -> SessionState:
    session = SessionState(
        session_id="ca4767",
        call_sid="CA47674e696de9285eb3abe90b1c19312a",
        from_number="+1",
        to_number="+2",
    )
    for key, value in kwargs.items():
        setattr(session, key, value)
    return session


class TestCA4767OrderInformation:
    def test_order_intent_without_number_detected(self):
        text = "Yeah. I am looking for order information."
        assert order_intent_detected(text)

    def test_order_handling_allowed_without_prior_context(self):
        session = _session()
        assert order_handling_allowed(session, "", "Yeah. I am looking for order information.")

    def test_collection_short_circuit_asks_for_number(self):
        session = _session()
        hint = try_order_collection_short_circuit(
            session, "Yeah. I am looking for order information.",
        )
        assert hint and hint.force_reply
        assert "order number" in hint.force_reply.lower()
        assert session.order_flow_status == "awaiting_order_number"

    def test_hallucinated_order_not_verified(self):
        session = _session()
        session.history = [
            {"role": "user", "content": "Hello. How are you?"},
            {"role": "assistant", "content": "I'm doing well."},
            {"role": "user", "content": "Yeah. I am looking for order information."},
        ]
        assert not caller_verified_order_number(session, "39787")

    def test_gate_blocks_unverified_lookup(self):
        session = _session()
        session.history = [
            {"role": "user", "content": "Yeah. I am looking for order information."},
        ]
        gate = gate_order_lookup_tool(
            "lookup_shopify_order_details", session, "39787",
        )
        assert gate is not None
        assert not gate.allowed
        assert gate.reason == "order_number_not_verified"

    @pytest.mark.asyncio
    async def test_dispatch_blocks_hallucinated_order_lookup(self):
        session = _session()
        session.history = [
            {"role": "user", "content": "Yeah. I am looking for order information."},
        ]
        raw = await dispatch(
            "lookup_shopify_order_details",
            {"order_number": "39787"},
            session,
        )
        data = json.loads(raw)
        assert data.get("success") is False
        assert data.get("error_code") == "order_number_not_verified"
        assert "order number" in (data.get("customer_message") or "").lower()

    def test_verified_when_caller_spoke_number(self):
        session = _session()
        session._current_caller_text = "My order number is 3 9 7 8 7."
        assert caller_verified_order_number(session, "39787")

    def test_verified_from_current_turn_text_before_history(self):
        session = _session()
        assert caller_verified_order_number(
            session, "39787", current_text="My order number is 3 9 7 8 7.",
        )
