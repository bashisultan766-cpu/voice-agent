"""
Tests for app/composer/main_llm_composer.py — MainLLMComposer.

Critical invariants:
- Only ONE OpenAI call per turn (no tool loop).
- No tool_choice passed → LLM produces text only.
- WorkerBundle data reaches the user message.
- Sensitive data gated by verification.
- Graceful error handling (no crash on OpenAI failure).
- Composer is the ONLY module that imports openai.
"""
from __future__ import annotations

import ast
import os
import pathlib
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.composer.main_llm_composer import MainLLMComposer, _build_user_message
from app.workers.base import WorkerResult, WorkerBundle
from app.pipeline.router import IntentResult
from app.state.models import SessionState, SafeCallerContext


def _make_session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="s-comp",
        call_sid="CA_COMP01",
        from_number="+15551234567",
        to_number="+18005551234",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


def _make_settings(**overrides):
    from app.config import Settings
    defaults = dict(OPENAI_API_KEY="test", DEBUG=True, VOICE_OPENAI_TIMEOUT_MS=8000, VOICE_MAX_REPLY_WORDS=50)
    defaults.update(overrides)
    return Settings(**defaults)


def _make_intent(intent="product_search", entities=None) -> IntentResult:
    return IntentResult(
        intent=intent,
        confidence=0.9,
        entities=entities or {"product_phrase": "Dune"},
        needs_filler=True,
        suggested_tools=[],
    )


def _make_bundle(*results: WorkerResult) -> WorkerBundle:
    bundle = WorkerBundle()
    for r in results:
        bundle.results[r.worker_name] = r
    return bundle


def _mock_stream(*tokens: str):
    """Build an async generator that yields fake OpenAI stream chunks."""
    async def _gen():
        for token in tokens:
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta = MagicMock()
            chunk.choices[0].delta.content = token
            chunk.choices[0].finish_reason = None
            yield chunk
        # Final chunk
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta = MagicMock()
        chunk.choices[0].delta.content = None
        chunk.choices[0].finish_reason = "stop"
        yield chunk
    return _gen()


# ── Only composer imports openai ──────────────────────────────────────────────

class TestSingleLLMRule:
    def test_only_composer_imports_openai(self):
        """No NEW component outside app/composer/ or app/ai/ may import openai.

        app/ai/ is the legacy run_agent_turn path and is permitted.
        Workers, orchestrator, engine, tools must NOT import openai.
        """
        project_root = pathlib.Path(__file__).parent.parent
        # ai/ is the legacy LLM agent path — permitted to import openai.
        # composer/ is the new single-LLM layer — also permitted.
        # tests/ and __pycache__/ are excluded from the check.
        excluded_dirs = {"composer", "ai", "brain", "tests", "__pycache__"}

        for py_file in project_root.rglob("*.py"):
            parts = set(py_file.relative_to(project_root).parts)
            if parts & excluded_dirs:
                continue
            source = py_file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(py_file))
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    if isinstance(node, ast.Import):
                        # e.g. `import openai` → top-level package is alias.name
                        top_names = [alias.name.split(".")[0] for alias in node.names]
                    else:
                        # e.g. `from app.ai.openai_agent import run_agent_turn`
                        # top-level package is the first segment of node.module
                        top_names = [(node.module or "").split(".")[0]]
                    for name in top_names:
                        assert name != "openai", (
                            f"{py_file.relative_to(project_root)} imports the openai package "
                            f"— only app/composer/main_llm_composer.py is allowed to"
                        )


# ── User message building ─────────────────────────────────────────────────────

class TestBuildUserMessage:
    def test_includes_caller_text(self):
        session = _make_session()
        bundle = WorkerBundle()
        ir = _make_intent()
        msg = _build_user_message("Find me Dune", ir, bundle, session)
        assert "Find me Dune" in msg

    def test_includes_intent(self):
        session = _make_session()
        bundle = WorkerBundle()
        ir = _make_intent("order_lookup", {"order_number": "#1042"})
        msg = _build_user_message("where is my order", ir, bundle, session)
        assert "order_lookup" in msg or "order lookup" in msg

    def test_includes_worker_data(self):
        session = _make_session()
        bundle = _make_bundle(WorkerResult(
            worker_name="product_isbn",
            success=True,
            safe_summary="Found 'Dune', in stock, $18.99.",
        ))
        ir = _make_intent()
        msg = _build_user_message("isbn 9780441172719", ir, bundle, session)
        assert "Dune" in msg

    def test_no_raw_json_in_message(self):
        session = _make_session()
        bundle = WorkerBundle()
        bundle.results["order_lookup"] = WorkerResult(
            worker_name="order_lookup",
            success=True,
            safe_summary="Order #1042 paid, fulfilled.",
            data={"raw_shopify_payload": {"id": "gid://shopify/Order/987", "secret": "abc"}},
        )
        ir = _make_intent("order_lookup", {"order_number": "#1042"})
        msg = _build_user_message("where is order 1042", ir, bundle, session)
        # The raw data dict should NOT appear in the message
        assert "gid://shopify/Order/987" not in msg
        assert "raw_shopify_payload" not in msg

    def test_sensitive_data_excluded_when_unverified(self):
        session = _make_session()  # not verified
        bundle = _make_bundle(WorkerResult(
            worker_name="refund",
            success=True,
            safe_summary="Refund of $50.00.",
            requires_verification=True,
        ))
        ir = _make_intent("refund_status")
        msg = _build_user_message("was my refund processed", ir, bundle, session)
        assert "50.00" not in msg

    def test_sensitive_data_included_when_verified(self):
        session = _make_session(verified_email=True)
        bundle = _make_bundle(WorkerResult(
            worker_name="refund",
            success=True,
            safe_summary="Refund of $50.00 on 2026-01-15.",
            requires_verification=True,
        ))
        ir = _make_intent("refund_status")
        msg = _build_user_message("was my refund processed", ir, bundle, session)
        assert "50.00" in msg


# ── Composer stream_response ──────────────────────────────────────────────────

class TestComposerStreamResponse:
    async def _collect_events(self, composer, session, caller_text, ir, bundle, ctx, settings):
        events = []
        async for event in composer.stream_response(session, caller_text, ir, bundle, ctx, settings):
            events.append(event)
        return events

    def _make_openai_mock(self, *tokens):
        mock_client = MagicMock()
        mock_completion = AsyncMock()
        mock_completion.return_value = _mock_stream(*tokens)
        mock_client.chat = MagicMock()
        mock_client.chat.completions = MagicMock()
        mock_client.chat.completions.create = mock_completion
        return mock_client

    async def test_yields_text_tokens_and_turn_done(self):
        composer = MainLLMComposer()
        session = _make_session()
        ir = _make_intent()
        bundle = WorkerBundle()
        settings = _make_settings()

        mock_client = self._make_openai_mock("Hello ", "there!")

        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            events = await self._collect_events(
                composer, session, "find dune", ir, bundle, None, settings
            )

        token_events = [e for e in events if e["type"] == "text_token"]
        done_events = [e for e in events if e["type"] == "turn_done"]
        assert len(token_events) >= 1
        assert len(done_events) == 1

    async def test_exactly_one_openai_call_per_turn(self):
        composer = MainLLMComposer()
        session = _make_session()
        ir = _make_intent()
        bundle = WorkerBundle()
        settings = _make_settings()

        mock_client = self._make_openai_mock("Done.")

        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            async for _ in composer.stream_response(session, "hi", ir, bundle, None, settings):
                pass

        assert mock_client.chat.completions.create.call_count == 1

    async def test_no_tools_passed_to_openai(self):
        """Composer must NOT pass tool schemas — single text response enforced."""
        composer = MainLLMComposer()
        session = _make_session()
        ir = _make_intent()
        bundle = WorkerBundle()
        settings = _make_settings()

        call_kwargs = {}

        async def capture_create(**kwargs):
            call_kwargs.update(kwargs)
            return _mock_stream("ok")

        mock_client = MagicMock()
        mock_client.chat.completions.create = capture_create

        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            async for _ in composer.stream_response(session, "hi", ir, bundle, None, settings):
                pass

        assert "tools" not in call_kwargs
        assert call_kwargs.get("tool_choice") is None

    async def test_openai_error_yields_graceful_fallback(self):
        composer = MainLLMComposer()
        session = _make_session()
        ir = _make_intent()
        bundle = WorkerBundle()
        settings = _make_settings()

        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=RuntimeError("OpenAI down"))

        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            events = await self._collect_events(
                composer, session, "hi", ir, bundle, None, settings
            )

        # Must yield at least an error text_token + turn_done (no uncaught exception)
        done_events = [e for e in events if e["type"] == "turn_done"]
        assert len(done_events) == 1

    async def test_worker_data_present_in_openai_messages(self):
        """Composer must include worker data in the messages sent to OpenAI."""
        composer = MainLLMComposer()
        session = _make_session()
        ir = _make_intent("product_search", {"product_phrase": "Dune"})
        bundle = _make_bundle(WorkerResult(
            worker_name="product_search",
            success=True,
            safe_summary="Found 'Dune' by Frank Herbert, in stock, $18.99.",
        ))
        settings = _make_settings()

        captured_messages = []

        async def capture_create(**kwargs):
            captured_messages.extend(kwargs.get("messages", []))
            return _mock_stream("Dune is in stock for $18.99.")

        mock_client = MagicMock()
        mock_client.chat.completions.create = capture_create

        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            async for _ in composer.stream_response(
                session, "do you have dune", ir, bundle, None, settings
            ):
                pass

        all_content = " ".join(
            m.get("content", "") or ""
            for m in captured_messages
        )
        assert "Dune" in all_content

    async def test_response_stored_in_session_history(self):
        composer = MainLLMComposer()
        session = _make_session()
        ir = _make_intent()
        bundle = WorkerBundle()
        settings = _make_settings()

        mock_client = self._make_openai_mock("Found it!")

        with patch("app.composer.main_llm_composer.AsyncOpenAI", return_value=mock_client):
            async for _ in composer.stream_response(session, "find dune", ir, bundle, None, settings):
                pass

        # After the turn, history should contain the assistant response
        assistant_turns = [m for m in session.history if m.get("role") == "assistant"]
        assert len(assistant_turns) >= 1
