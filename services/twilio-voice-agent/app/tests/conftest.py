"""Shared pytest fixtures for twilio-voice-agent tests."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("RESEND_API_KEY", "re_test_key")
os.environ.setdefault("RESEND_FROM_EMAIL", "noreply@example.com")


@pytest.fixture(autouse=True)
def _reset_v413_global_state():
    """Prevent conversation state / interrupt context leaking between tests."""
    from app.agent_runtime.conversation_state_machine import clear_all_conversation_states
    from app.agent_runtime.interruption_manager import _contexts
    clear_all_conversation_states()
    _contexts.clear()
    yield
    clear_all_conversation_states()
    _contexts.clear()
