"""Anti-silence and human voice quality regressions."""
from __future__ import annotations

from app.agent_runtime.commerce_flow_state import (
    COMMERCE_FLOW_VERSION,
    STATUS_AWAITING_QUANTITY,
    stage_product_candidate,
)
from app.agents.main_commerce_brain import MainCommerceBrain
from app.dialogue.anti_silence import anti_silence_reply, caller_needs_presence_reply
from app.state.models import SessionState
from app.voice.turn_assembler import AssembledTurn


def _session(**kwargs) -> SessionState:
    base = dict(
        session_id="anti_silence",
        call_sid="CAanti01",
        from_number="+1",
        to_number="+2",
    )
    base.update(kwargs)
    return SessionState(**base)


class TestVersions:
    def test_commerce_flow_version(self):
        assert COMMERCE_FLOW_VERSION == "v4.56"


class TestAntiSilence:
    def test_detects_silence_complaint(self):
        assert caller_needs_presence_reply("Why are you keep silence.")
        assert caller_needs_presence_reply("Hello? Are you there?")

    def test_silence_reply_during_quantity(self):
        session = _session()
        stage_product_candidate(session, {
            "title": "A Game of Thrones",
            "isbn": "9780553573404",
            "variant_id": "v1",
            "price": "9.99",
            "available": True,
        })
        assert session.commerce_flow_status == STATUS_AWAITING_QUANTITY
        reply = anti_silence_reply(session, "Why are you not talking?")
        assert reply
        assert "here" in reply.lower()
        assert "copies" in reply.lower() or "copy" in reply.lower()


class TestBrainModel:
    def test_default_brain_uses_voice_brain_model(self):
        from app.tests.test_voice_commerce_runtime import _FakeSettings

        brain = MainCommerceBrain(_FakeSettings())
        assert brain._select_model(use_strong=False) == "gpt-4o"


class TestAssemblerKeepalive:
    def test_assembled_turn_agent_reply_field(self):
        turn = AssembledTurn(
            text="hold on",
            mode="normal",
            agent_reply="No problem, I'm here. Go ahead when you're ready.",
        )
        assert turn.agent_reply
        assert turn.text == "hold on"
