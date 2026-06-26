"""
Tests for SafeCallerContext, mask_email, build_safe_caller_context,
and the system prompt caller context section.

Covers:
A. Returning caller context passed to OpenAI
B. Sensitive data safety
C. System prompt content
D. Non-returning caller behaviour
E. mask_email edge cases
"""
from __future__ import annotations

import os
import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SafeCallerContext, SessionState
from app.caller.repository import mask_email, build_safe_caller_context
from app.ai.system_prompt import build_system_message, _build_caller_context_section


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="sess-test",
        call_sid="CA_CTX_TEST",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


def _returning_session(**kwargs) -> SessionState:
    return _make_session(
        is_returning_caller=True,
        caller_name="Darren",
        caller_email="darren@example.com",
        caller_call_count=3,
        caller_last_summary="Asked about a recent order.",
        caller_profile_loaded=True,
        last_order_number="#1042",
        **kwargs,
    )


# ── A. Returning caller context ───────────────────────────────────────────────

class TestBuildSafeCallerContext:
    def test_returning_caller_fields_populated(self):
        session = _returning_session()
        ctx = build_safe_caller_context(session, greeted_already=True)

        assert ctx.is_returning_caller is True
        assert ctx.caller_name == "Darren"
        assert ctx.call_count == 3
        assert ctx.last_order_number == "#1042"
        assert ctx.last_summary == "Asked about a recent order."
        assert ctx.greeted_already is True

    def test_new_caller_fields_empty(self):
        session = _make_session()
        ctx = build_safe_caller_context(session)

        assert ctx.is_returning_caller is False
        assert ctx.caller_name == ""
        assert ctx.call_count is None
        assert ctx.last_order_number == ""
        assert ctx.preferred_email_masked == ""
        assert ctx.greeted_already is False

    def test_verification_flags_reflect_session(self):
        session = _returning_session(verified_email=True, verified_phone=False)
        ctx = build_safe_caller_context(session)
        assert ctx.verified_email is True
        assert ctx.verified_phone is False

    def test_unverified_by_default(self):
        session = _returning_session()  # no verified_* set
        ctx = build_safe_caller_context(session)
        assert ctx.verified_email is False
        assert ctx.verified_phone is False

    def test_zero_call_count_becomes_none(self):
        session = _make_session(is_returning_caller=True, caller_call_count=0)
        ctx = build_safe_caller_context(session)
        assert ctx.call_count is None


# ── B. Sensitive data safety ──────────────────────────────────────────────────

class TestSensitiveDataSafety:
    def test_email_is_always_masked(self):
        session = _returning_session()
        ctx = build_safe_caller_context(session)

        # Must not contain raw email
        assert "darren@example.com" not in ctx.preferred_email_masked
        # Must be the masked form
        assert ctx.preferred_email_masked == "d***n@example.com"

    def test_full_email_not_in_system_prompt_unverified(self):
        session = _returning_session()
        ctx = build_safe_caller_context(session)
        msg = build_system_message(caller_context=ctx)
        # Full email must not appear
        assert "darren@example.com" not in msg["content"]

    def test_full_email_not_in_system_prompt_even_if_verified(self):
        """Even after email verification, the prompt section uses masked form."""
        session = _returning_session(verified_email=True)
        ctx = build_safe_caller_context(session)
        msg = build_system_message(caller_context=ctx)
        assert "darren@example.com" not in msg["content"]

    def test_context_contains_no_payment_data(self):
        """SafeCallerContext has no card/payment/CVV fields."""
        ctx = SafeCallerContext(is_returning_caller=True, caller_name="Darren")
        ctx_dict = ctx.__dict__
        for key in ctx_dict:
            assert "card" not in key.lower()
            assert "cvv" not in key.lower()
            assert "payment" not in key.lower()

    def test_context_has_no_raw_transcript_field(self):
        """SafeCallerContext must not store raw transcripts."""
        ctx = SafeCallerContext()
        assert not hasattr(ctx, "transcript")
        assert not hasattr(ctx, "raw_transcript")
        assert not hasattr(ctx, "full_history")

    def test_last_summary_is_short_non_sensitive(self):
        session = _returning_session()
        ctx = build_safe_caller_context(session)
        # Summary comes from the session field — not a full transcript
        assert len(ctx.last_summary) <= 300

    def test_order_number_in_context_but_not_details(self):
        """Order number may appear (for helpful follow-up) but no order items/amounts."""
        session = _returning_session()
        ctx = build_safe_caller_context(session)
        # last_order_number is present
        assert ctx.last_order_number == "#1042"
        # But there are no item/price/shipping fields
        assert not hasattr(ctx, "last_order_items")
        assert not hasattr(ctx, "last_order_total")
        assert not hasattr(ctx, "last_order_address")


# ── C. System prompt content ──────────────────────────────────────────────────

class TestSystemPromptCallerContext:
    def test_returning_caller_section_in_prompt(self):
        ctx = SafeCallerContext(
            is_returning_caller=True,
            caller_name="Darren",
            call_count=3,
            last_order_number="#1042",
            preferred_email_masked="d***n@example.com",
        )
        msg = build_system_message(caller_context=ctx)
        content = msg["content"]

        assert "CALLER CONTEXT" in content
        assert "Darren" in content
        assert "#1042" in content
        assert "d***n@example.com" in content

    def test_prompt_states_verification_requirement(self):
        """Prompt must include a rule about verification for unverified callers."""
        ctx = SafeCallerContext(is_returning_caller=True, caller_name="Darren")
        msg = build_system_message(caller_context=ctx)
        content = msg["content"]

        assert "verification" in content.lower() or "verified" in content.lower() or "verify" in content.lower()
        assert "order" in content.lower() or "refund" in content.lower()

    def test_prompt_warns_not_to_repeat_greeting(self):
        """When greeted_already=True, prompt must tell LLM not to repeat greeting."""
        ctx = SafeCallerContext(
            is_returning_caller=True,
            caller_name="Darren",
            greeted_already=True,
        )
        msg = build_system_message(caller_context=ctx)
        content = msg["content"]
        assert "already greeted" in content.lower() or "not repeat" in content.lower() or "do not repeat" in content.lower()

    def test_prompt_not_repeat_greeting_absent_when_not_greeted(self):
        """When greeted_already=False, no instruction to suppress greeting."""
        ctx = SafeCallerContext(is_returning_caller=True, caller_name="Darren", greeted_already=False)
        msg = build_system_message(caller_context=ctx)
        # The "do not repeat" warning should be absent
        content = msg["content"]
        assert "already greeted" not in content.lower()

    def test_verification_status_verified_email_shown(self):
        ctx = SafeCallerContext(is_returning_caller=True, verified_email=True)
        msg = build_system_message(caller_context=ctx)
        assert "email verified" in msg["content"].lower() or "verified this call: yes" in msg["content"].lower()

    def test_prompt_includes_important_security_note(self):
        """Prompt must always include the IMPORTANT security override."""
        ctx = SafeCallerContext(is_returning_caller=True, caller_name="Darren")
        section = _build_caller_context_section(ctx)
        assert "IMPORTANT" in section
        assert "verification" in section.lower()

    def test_no_caller_context_produces_clean_prompt(self):
        """When caller_context=None, no CALLER CONTEXT section is added."""
        msg = build_system_message()
        assert "CALLER CONTEXT" not in msg["content"]

    def test_system_message_role_always_system(self):
        ctx = SafeCallerContext(is_returning_caller=True)
        msg = build_system_message(caller_context=ctx)
        assert msg["role"] == "system"


# ── D. Non-returning caller ───────────────────────────────────────────────────

class TestNewCaller:
    def test_new_caller_no_name_injected(self):
        session = _make_session()
        ctx = build_safe_caller_context(session)
        assert ctx.is_returning_caller is False
        assert ctx.caller_name == ""

    def test_new_caller_prompt_says_no_profile(self):
        ctx = SafeCallerContext(is_returning_caller=False)
        section = _build_caller_context_section(ctx)
        assert "new caller" in section.lower() or "no profile" in section.lower()

    def test_new_caller_prompt_no_invented_name(self):
        ctx = SafeCallerContext(is_returning_caller=False)
        section = _build_caller_context_section(ctx)
        # Should not contain any name (no "Name: ..." line)
        assert "Name:" not in section

    def test_new_caller_system_message_no_name(self):
        session = _make_session()
        ctx = build_safe_caller_context(session)
        msg = build_system_message(caller_context=ctx)
        content = msg["content"]
        # No fake name claim
        assert "Name:" not in content


# ── E. mask_email ─────────────────────────────────────────────────────────────

class TestMaskEmail:
    def test_normal_email(self):
        assert mask_email("darren@example.com") == "d***n@example.com"

    def test_two_char_local(self):
        assert mask_email("ab@example.com") == "a***b@example.com"

    def test_single_char_local(self):
        # Only one char in local part — can't show first+last
        result = mask_email("a@example.com")
        assert result == "a***@example.com"

    def test_empty_string(self):
        assert mask_email("") == "***"

    def test_no_at_sign(self):
        assert mask_email("notanemail") == "***"

    def test_long_email(self):
        result = mask_email("verylonglocalpart@subdomain.example.com")
        assert result.startswith("v***")
        assert "@subdomain.example.com" in result

    def test_none_like_empty(self):
        # Passing None would TypeError — passing empty str should not raise
        result = mask_email("")
        assert result == "***"

    def test_domain_preserved_exactly(self):
        result = mask_email("jo@mycompany.org")
        # Domain must be intact
        assert result.endswith("@mycompany.org")


# ── F. SafeCallerContext passed to run_agent_turn ─────────────────────────────

class TestAgentTurnCallerContext:
    """Tests for run_agent_turn caller context injection.

    These tests use VOICE_LIVE_DISABLE_OPENAI_TOOLS=False to test the
    legacy tool-calling path directly. In production v4.2, this path is
    disabled and all turns use the worker→composer path instead.
    """

    def _legacy_settings(self):
        from app.config import Settings
        return Settings(
            OPENAI_API_KEY="test",
            DEBUG=True,
            VOICE_LIVE_DISABLE_OPENAI_TOOLS=False,  # allow legacy path for these tests
        )

    async def test_system_message_includes_caller_name_on_first_turn(self):
        """When caller_context is provided, session.history[0] should mention the name."""
        from unittest.mock import AsyncMock, patch

        session = _make_session(
            is_returning_caller=True,
            caller_name="Darren",
            caller_call_count=2,
        )
        ctx = build_safe_caller_context(session, greeted_already=True)

        mock_chunk = AsyncMock()
        mock_chunk.choices = [
            type("C", (), {
                "delta": type("D", (), {"content": "Hi!", "tool_calls": None})(),
                "finish_reason": "stop",
            })()
        ]

        async def fake_stream():
            yield mock_chunk

        mock_completion = AsyncMock()
        mock_completion.__aiter__ = lambda self: fake_stream()

        with patch("app.ai.openai_agent._get_client") as mock_client_factory:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_completion)
            mock_client_factory.return_value = mock_client

            from app.ai.openai_agent import run_agent_turn

            events = []
            async for event in run_agent_turn(
                session, "Hello", settings=self._legacy_settings(), caller_context=ctx
            ):
                events.append(event)

        assert session.history[0]["role"] == "system"
        assert "Darren" in session.history[0]["content"]

    async def test_system_message_no_name_for_new_caller(self):
        """New caller should not have a name in the system message."""
        from unittest.mock import AsyncMock, patch

        session = _make_session()
        ctx = build_safe_caller_context(session)

        mock_chunk = AsyncMock()
        mock_chunk.choices = [
            type("C", (), {
                "delta": type("D", (), {"content": "Hi!", "tool_calls": None})(),
                "finish_reason": "stop",
            })()
        ]

        async def fake_stream():
            yield mock_chunk

        mock_completion = AsyncMock()
        mock_completion.__aiter__ = lambda self: fake_stream()

        with patch("app.ai.openai_agent._get_client") as mock_client_factory:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_completion)
            mock_client_factory.return_value = mock_client

            from app.ai.openai_agent import run_agent_turn

            async for _ in run_agent_turn(
                session, "Hello", settings=self._legacy_settings(), caller_context=ctx
            ):
                pass

        system_content = session.history[0]["content"]
        assert "no profile" in system_content.lower() or "new caller" in system_content.lower()
        assert "Name:" not in system_content

    async def test_caller_context_none_still_works(self):
        """Backward compat: caller_context=None should not break the agent."""
        from unittest.mock import AsyncMock, patch

        session = _make_session()

        mock_chunk = AsyncMock()
        mock_chunk.choices = [
            type("C", (), {
                "delta": type("D", (), {"content": "Hello!", "tool_calls": None})(),
                "finish_reason": "stop",
            })()
        ]

        async def fake_stream():
            yield mock_chunk

        mock_completion = AsyncMock()
        mock_completion.__aiter__ = lambda self: fake_stream()

        with patch("app.ai.openai_agent._get_client") as mock_client_factory:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = AsyncMock(return_value=mock_completion)
            mock_client_factory.return_value = mock_client

            from app.ai.openai_agent import run_agent_turn

            events = []
            async for event in run_agent_turn(
                session, "Hello", settings=self._legacy_settings(), caller_context=None
            ):
                events.append(event)

        assert any(e["type"] == "turn_done" for e in events)
        assert "CALLER CONTEXT" not in session.history[0]["content"]
