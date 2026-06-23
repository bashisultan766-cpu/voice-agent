"""v4.13 — Interrupt repair tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")


@pytest.fixture(autouse=True)
def _clear():
    from app.agent_runtime.interruption_manager import clear_interrupt_context
    clear_interrupt_context("CA413INT")
    yield
    clear_interrupt_context("CA413INT")


class TestInterruptionManager:
    def test_interrupt_what_repeats_last(self):
        from app.agent_runtime.interruption_manager import (
            record_interrupt, try_interrupt_repair,
        )
        record_interrupt(
            "CA413INT",
            previous_intent="identity",
            previous_response="My name is Eric. I'm with SureShot Books.",
        )
        handled, text, repair = try_interrupt_repair(
            "CA413INT", "What?", last_safe_response="My name is Eric.",
        )
        assert handled is True
        assert repair == "repeat_last"
        assert "Eric" in text

    def test_classify_repeat(self):
        from app.agent_runtime.interruption_manager import classify_interrupt_repair
        assert classify_interrupt_repair("What?") == "repeat_last"
        assert classify_interrupt_repair("What did you say?") == "repeat_last"
