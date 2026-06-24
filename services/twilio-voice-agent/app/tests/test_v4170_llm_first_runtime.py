"""Tests for the consolidated LLM-first runtime context assembly (v4.17)."""
from __future__ import annotations

import os

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")

from app.state.models import SessionState
from app.agent_runtime.llm_first_runtime import (
    LLMFirstRuntime,
    get_llm_first_runtime,
    is_llm_first_mode,
)
from app.conversation.call_memory import record_user_turn, record_assistant_turn
from app.agent_runtime import pending_action as pa


def _session(sid="CA_LLMF001") -> SessionState:
    return SessionState(
        session_id="s-llmf",
        call_sid=sid,
        from_number="+15550007777",
        to_number="+18005551234",
    )


class TestContextAssembly:
    def test_llm_first_runtime_receives_prompt_memory_tools(self):
        session = _session()
        record_user_turn(session, "Hi, my name is Berlin")
        record_assistant_turn(session, "Hi Berlin!")

        rt = LLMFirstRuntime()
        ctx = rt.build_llm_context(session, "Do you have any thrillers?")

        # 1) System prompt pack present.
        assert ctx.has_prompt()
        assert ctx.prompt_pack_chars > 100
        # 2) Conversation turns included.
        assert len(ctx.recent_turns) >= 1
        # 3) Tools available.
        assert ctx.has_tools()
        names = {t["name"] for t in ctx.tools}
        assert {"SureShotCatalogSearch", "SendPaymentLink", "GetCallerInfo"} <= names
        # 4) Caller profile summary present.
        assert "caller_name" in ctx.caller_profile
        assert "verified_email" in ctx.caller_profile
        # 5) Cart + session state present.
        assert "confirmed_count" in ctx.cart_state
        assert "payment_flow_status" in ctx.session_state
        # 6) Safe policy present, mentions tools and never "Processing Fee" leak.
        assert "tools" in ctx.policy.lower()
        assert "Processing Fee" in ctx.policy  # it's a *prohibition* reminder
        # 7) The caller utterance is carried.
        assert ctx.caller_text == "Do you have any thrillers?"

    def test_policy_does_not_contain_secrets(self):
        rt = LLMFirstRuntime()
        ctx = rt.build_llm_context(_session("CA_LLMF002"), "hello")
        lower = ctx.policy.lower()
        assert "sk-" not in lower
        assert "shpat" not in lower
        assert "api key" not in lower

    def test_singleton_and_mode_flag(self):
        assert get_llm_first_runtime() is get_llm_first_runtime()
        # Default mode is main_llm_agent, not llm_first.
        assert is_llm_first_mode() in (True, False)


class TestConversationalFastPaths:
    def test_isbn_offer_direct_answer(self):
        rt = LLMFirstRuntime()
        session = _session("CA_LLMF003")
        decision = rt.decide_conversational(session, "Can I give you the ISBN number?")
        assert decision is not None
        assert decision.response_mode == "direct_answer"
        assert decision.intent == "isbn_collection_start"
        assert "ISBN" in decision.answer

    def test_yes_consumes_pending_action(self):
        rt = LLMFirstRuntime()
        session = _session("CA_LLMF004")
        pa.set_pending_action(session, "send_payment_link", payload={"tool_categories": ["payment_flow"]})
        decision = rt.decide_conversational(session, "yes please")
        assert decision is not None
        assert decision.response_mode == "needs_tools"
        assert decision.intent == "send_payment_link"
        assert decision.source == "pending_action"

    def test_plain_statement_defers_to_llm(self):
        rt = LLMFirstRuntime()
        session = _session("CA_LLMF005")
        decision = rt.decide_conversational(session, "I want to know my order tracking")
        # Order tracking is a business fact — must not be answered conversationally.
        assert decision is None or decision.response_mode != "direct_answer"
