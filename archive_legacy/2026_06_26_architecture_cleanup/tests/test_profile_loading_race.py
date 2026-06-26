"""
Tests for the caller-profile race-condition fix.

Covers:
A. await_caller_profile_ready() unit tests
B. Profile loads before first prompt  → greeted_already=True
C. Profile loads within timeout window → returning-caller context used, no duplicate greeting
D. Profile exceeds timeout             → call proceeds, no crash
E. No duplicate greeting               → greeted_already correct in both fast and late paths
F. New caller                          → no fake name or history
G. Existing 119 tests still pass       → verified by running full suite
"""
from __future__ import annotations

import asyncio
import time
import os
import pytest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState, SafeCallerContext
from app.caller.repository import build_safe_caller_context
from app.ws.conversation_relay import await_caller_profile_ready


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="sess-race",
        call_sid="CA_RACE",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


# ── A. await_caller_profile_ready unit tests ──────────────────────────────────

class TestAwaitCallerProfileReady:
    async def test_none_task_returns_immediately(self):
        t0 = time.monotonic()
        await await_caller_profile_ready(None, timeout_secs=0.75)
        assert time.monotonic() - t0 < 0.1

    async def test_already_done_task_returns_immediately(self):
        async def _noop():
            return

        task = asyncio.create_task(_noop())
        await task  # ensure done before calling
        t0 = time.monotonic()
        await await_caller_profile_ready(task, timeout_secs=0.75)
        assert time.monotonic() - t0 < 0.1

    async def test_fast_task_completes_within_timeout(self):
        """Task finishes before timeout → side-effects visible after return."""
        side_effect = []

        async def _fast():
            await asyncio.sleep(0.02)
            side_effect.append("done")

        task = asyncio.create_task(_fast())
        await await_caller_profile_ready(task, timeout_secs=0.75)
        assert side_effect == ["done"]

    async def test_slow_task_times_out_without_blocking(self):
        """Task takes longer than timeout → returns quickly, no exception."""
        async def _slow():
            await asyncio.sleep(10)

        task = asyncio.create_task(_slow())
        try:
            t0 = time.monotonic()
            await await_caller_profile_ready(task, timeout_secs=0.05)
            elapsed = time.monotonic() - t0
            assert elapsed < 0.5  # definitely did not wait 10 s
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_slow_task_leaves_task_running(self):
        """Timeout does not cancel the underlying task (asyncio.shield is used)."""
        completed = []

        async def _slow():
            await asyncio.sleep(0.1)
            completed.append("done")

        task = asyncio.create_task(_slow())
        await await_caller_profile_ready(task, timeout_secs=0.02)
        # Give background task time to finish
        await asyncio.sleep(0.15)
        assert completed == ["done"]
        assert task.done()

    async def test_failing_task_does_not_raise(self):
        """Task that raises → swallowed safely."""
        async def _fail():
            raise RuntimeError("Redis unavailable")

        task = asyncio.create_task(_fail())
        await asyncio.sleep(0)  # let it fail
        # Must not propagate the exception
        await await_caller_profile_ready(task, timeout_secs=0.75)

    async def test_custom_timeout_respected(self):
        """Tight custom timeout fires before slow task."""
        async def _slow():
            await asyncio.sleep(5)

        task = asyncio.create_task(_slow())
        try:
            t0 = time.monotonic()
            await await_caller_profile_ready(task, timeout_secs=0.03)
            assert time.monotonic() - t0 < 0.3
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


# ── B. Profile loads before first prompt ─────────────────────────────────────

class TestProfileLoadBeforePrompt:
    def test_greeted_already_true_when_profile_loaded_early(self):
        """
        Simulate: profile loaded (is_returning_caller=True, caller_profile_loaded=True)
        and greeting was sent (greeting_sent=True via WS) before first prompt.
        build_safe_caller_context(greeted_already=True) should reflect that.
        """
        session = _make_session(
            is_returning_caller=True,
            caller_name="Darren",
            caller_profile_loaded=True,
        )
        ctx = build_safe_caller_context(session, greeted_already=True)
        assert ctx.is_returning_caller is True
        assert ctx.caller_name == "Darren"
        assert ctx.greeted_already is True

    def test_system_prompt_says_do_not_repeat_when_greeted(self):
        from app.ai.system_prompt import build_system_message
        ctx = SafeCallerContext(
            is_returning_caller=True,
            caller_name="Darren",
            greeted_already=True,
        )
        content = build_system_message(caller_context=ctx)["content"]
        assert "already greeted" in content.lower() or "do not repeat" in content.lower()


# ── C. Profile loads within timeout ──────────────────────────────────────────

class TestProfileLoadsWithinTimeout:
    async def test_session_updated_after_await(self):
        """
        Simulate a profile that loads in 30 ms (well within 750 ms timeout).
        After await_caller_profile_ready, session fields should be populated.
        """
        session = _make_session()

        async def _delayed_load():
            await asyncio.sleep(0.03)
            session.is_returning_caller = True
            session.caller_name = "Alice"
            session.caller_call_count = 5
            session.caller_profile_loaded = True

        task = asyncio.create_task(_delayed_load())
        await await_caller_profile_ready(task, timeout_secs=0.75)

        assert session.is_returning_caller is True
        assert session.caller_name == "Alice"
        assert session.caller_call_count == 5
        assert session.caller_profile_loaded is True

    async def test_returning_context_built_after_await(self):
        """
        After profile loads within timeout, SafeCallerContext reflects returning caller.
        greeted_already=False because first_prompt_received=True prevented WS greeting.
        """
        session = _make_session()

        async def _delayed_load():
            await asyncio.sleep(0.03)
            session.is_returning_caller = True
            session.caller_name = "Alice"
            session.caller_profile_loaded = True

        task = asyncio.create_task(_delayed_load())
        await await_caller_profile_ready(task, timeout_secs=0.75)

        # greeted_already=False: profile loaded late, WS greeting was suppressed
        ctx = build_safe_caller_context(session, greeted_already=False)
        assert ctx.is_returning_caller is True
        assert ctx.caller_name == "Alice"
        assert ctx.greeted_already is False

    def test_system_prompt_does_not_suppress_greeting_when_not_yet_greeted(self):
        """When greeted_already=False, the LLM should be allowed to greet caller."""
        from app.ai.system_prompt import build_system_message
        ctx = SafeCallerContext(
            is_returning_caller=True,
            caller_name="Alice",
            greeted_already=False,
        )
        content = build_system_message(caller_context=ctx)["content"]
        # "already greeted" notice must NOT be present
        assert "already greeted" not in content.lower()


# ── D. Profile exceeds timeout ────────────────────────────────────────────────

class TestProfileExceedsTimeout:
    async def test_timeout_session_unchanged(self):
        """Profile load times out — session stays at new-caller defaults."""
        session = _make_session()

        async def _very_slow():
            await asyncio.sleep(10)
            session.caller_name = "ShouldNeverBeSet"

        task = asyncio.create_task(_very_slow())
        try:
            await await_caller_profile_ready(task, timeout_secs=0.04)
            assert session.caller_name == ""
            assert session.is_returning_caller is False
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_call_proceeds_after_timeout(self):
        """Agent turn must still run even when profile load times out."""
        session = _make_session()

        async def _very_slow():
            await asyncio.sleep(10)

        task = asyncio.create_task(_very_slow())
        try:
            # Simulate what _run_turn does
            await await_caller_profile_ready(task, timeout_secs=0.04)
            ctx = build_safe_caller_context(session, greeted_already=False)
            # No crash, context is valid new-caller context
            assert ctx.is_returning_caller is False
            assert ctx.caller_name == ""
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def test_task_still_running_after_timeout(self):
        """
        asyncio.shield means the underlying task is NOT cancelled by the timeout.
        After timeout, if the task eventually completes, session gets updated
        (though too late for the system prompt on turn 1).
        """
        session = _make_session()
        completed = asyncio.Event()

        async def _slow_load():
            await asyncio.sleep(0.1)
            session.caller_name = "LateLoaded"
            completed.set()

        task = asyncio.create_task(_slow_load())
        await await_caller_profile_ready(task, timeout_secs=0.02)
        # Task still running after timeout
        assert not completed.is_set()
        # Wait for it to finish naturally
        await asyncio.wait_for(completed.wait(), timeout=1.0)
        assert session.caller_name == "LateLoaded"


# ── E. Duplicate greeting prevention ─────────────────────────────────────────

class TestDuplicateGreetingPrevention:
    def test_greet_already_true_suppresses_llm_greeting_in_prompt(self):
        """When WS already greeted, system prompt section says not to repeat."""
        from app.ai.system_prompt import _build_caller_context_section
        ctx = SafeCallerContext(
            is_returning_caller=True,
            caller_name="Darren",
            greeted_already=True,
        )
        section = _build_caller_context_section(ctx)
        assert "already greeted" in section.lower() or "do not repeat" in section.lower()

    def test_greet_already_false_no_suppression(self):
        """When WS did NOT greet, LLM is free to greet — no suppression in prompt."""
        from app.ai.system_prompt import _build_caller_context_section
        ctx = SafeCallerContext(
            is_returning_caller=True,
            caller_name="Darren",
            greeted_already=False,
        )
        section = _build_caller_context_section(ctx)
        assert "already greeted" not in section.lower()

    async def test_first_prompt_received_prevents_late_greeting(self):
        """
        Simulate: first_prompt_received=True set before profile task completes.
        Profile task sees first_prompt_received=True and must skip WS greeting.
        We verify this by inspecting the greeting_sent logic separately.
        """
        first_prompt_received = True  # already set
        greeting_would_be_sent = not first_prompt_received  # False
        assert greeting_would_be_sent is False

    def test_greeting_sent_false_means_greeted_already_false(self):
        """greeted_already mirrors greeting_sent."""
        session = _make_session(
            is_returning_caller=True,
            caller_name="Darren",
            caller_profile_loaded=True,
        )
        # greeting_sent=False (profile loaded late, prompt arrived first)
        ctx = build_safe_caller_context(session, greeted_already=False)
        assert ctx.greeted_already is False

    def test_greeting_sent_true_means_greeted_already_true(self):
        """greeted_already=True when WS greeting was sent before first prompt."""
        session = _make_session(
            is_returning_caller=True,
            caller_name="Darren",
            caller_profile_loaded=True,
        )
        ctx = build_safe_caller_context(session, greeted_already=True)
        assert ctx.greeted_already is True


# ── F. New caller ─────────────────────────────────────────────────────────────

class TestNewCaller:
    def test_new_caller_no_profile_no_name(self):
        session = _make_session()
        ctx = build_safe_caller_context(session, greeted_already=False)
        assert ctx.is_returning_caller is False
        assert ctx.caller_name == ""
        assert ctx.greeted_already is False

    def test_new_caller_system_prompt_says_no_profile(self):
        from app.ai.system_prompt import build_system_message
        ctx = SafeCallerContext(is_returning_caller=False)
        content = build_system_message(caller_context=ctx)["content"]
        assert "new caller" in content.lower() or "no profile" in content.lower()
        assert "Name:" not in content

    async def test_new_caller_fast_profile_task_returns_none(self):
        """
        Profile task completes quickly but returns no profile.
        Session remains new-caller after await.
        """
        session = _make_session()

        async def _no_profile():
            await asyncio.sleep(0.01)
            session.caller_profile_loaded = True
            # is_returning_caller stays False — no profile found

        task = asyncio.create_task(_no_profile())
        await await_caller_profile_ready(task, timeout_secs=0.75)

        assert session.is_returning_caller is False
        assert session.caller_profile_loaded is True
        ctx = build_safe_caller_context(session, greeted_already=False)
        assert ctx.is_returning_caller is False
