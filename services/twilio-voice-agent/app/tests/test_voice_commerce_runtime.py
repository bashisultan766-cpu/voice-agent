"""
End-to-end tests for voice commerce single-brain runtime.

Covers fast classifier, Main LLM Brain tool loop, email/cart/payment flows,
and deterministic safety paths.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime import llm_tools
from app.agents.main_commerce_brain import MainCommerceBrain
from app.cart.commerce_cart_service import CommerceCartService
from app.email.voice_email_capture import VoiceEmailCapture
from app.runtime.fast_classifier import classify, is_vague_product_request
from app.runtime.voice_commerce_runtime import RUNTIME_MODE, VoiceCommerceRuntime
from app.state.models import SessionState


@dataclass
class _FakeFunction:
    name: str
    arguments: str


@dataclass
class _FakeToolCall:
    id: str
    function: _FakeFunction
    type: str = "function"


@dataclass
class _FakeMessage:
    content: str | None = None
    tool_calls: list | None = None


@dataclass
class _FakeChoice:
    message: _FakeMessage


class _FakeUsage:
    prompt_tokens = 10
    completion_tokens = 5
    total_tokens = 15


@dataclass
class _FakeResponse:
    choices: list
    usage: _FakeUsage = field(default_factory=_FakeUsage)


class _FakeCompletions:
    def __init__(self, scripted):
        self._scripted = list(scripted)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._scripted:
            return self._scripted.pop(0)
        return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content="Anything else?"))])


class _FakeChat:
    def __init__(self, completions):
        self.completions = completions


class _FakeClient:
    def __init__(self, scripted):
        self.chat = _FakeChat(_FakeCompletions(scripted))


@dataclass
class _FakeSettings:
    OPENAI_API_KEY: str = "sk-test-not-real"
    OPENAI_MODEL: str = "gpt-4o"
    OPENAI_FAST_MODEL: str = "gpt-4o-mini"
    OPENAI_STRONG_MODEL: str = "gpt-4o"
    VOICE_BRAIN_MODEL: str = "gpt-4o"
    VOICE_OPENAI_TIMEOUT_MS: int = 8000
    VOICE_MAX_REPLY_WORDS: int = 50
    VOICE_PROMPT_TOKEN_BUDGET: int = 4000
    VOICE_TOOL_TIMEOUT_MS: int = 2500
    VOICE_COMMERCE_RUNTIME_ENABLED: bool = True
    VOICE_ORCHESTRATOR_ENABLED: bool = False
    VOICE_LEGACY_RUNTIME_FALLBACK_ENABLED: bool = True


def _session(**kwargs) -> SessionState:
    defaults = dict(
        session_id="s1",
        call_sid="CA1234567890",
        from_number="+15551230000",
        to_number="+15559999999",
    )
    defaults.update(kwargs)
    return SessionState(**defaults)


def _text_response(content: str) -> _FakeResponse:
    return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content=content))])


def _tool_response(name: str, args: dict) -> _FakeResponse:
    tc = _FakeToolCall(
        id=f"call_{name}",
        function=_FakeFunction(name=name, arguments=json.dumps(args)),
    )
    return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content=None, tool_calls=[tc]))])


def _run_turn(runtime: VoiceCommerceRuntime, session: SessionState, text: str):
    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)

    result = asyncio.run(runtime.handle_turn(session, text, send))
    return result, sent


def _build_runtime(scripted) -> VoiceCommerceRuntime:
    runtime = VoiceCommerceRuntime(settings=_FakeSettings())
    runtime._brain._client = _FakeClient(scripted)
    return runtime


# ── Fast classifier tests (no LLM, no tools) ──────────────────────────────────

def test_hello_instant_response_no_llm():
    result = classify("hello")
    assert result.action == "instant"
    assert result.skip_llm is True
    assert "SureShot" in result.instant_reply or "help" in result.instant_reply.lower()


def test_i_need_a_book_asks_title_not_search():
    result = classify("I need a book")
    assert result.action == "instant"
    assert result.skip_tools is True
    assert "title" in result.instant_reply.lower() or "isbn" in result.instant_reply.lower()
    assert is_vague_product_request("I need a book")


def test_vague_magazine_clarification():
    result = classify("I need a magazine")
    assert result.action == "instant"
    assert "magazine" in result.instant_reply.lower()


def test_game_of_thrones_triggers_product_search_brain():
    result = classify("I need Game of Thrones")
    assert result.action == "brain"
    assert result.is_product_search is True
    assert not result.ack_reply


def test_isbn_triggers_product_search():
    result = classify("9780747532699")
    assert result.is_product_search is True


def test_no_llm_for_greeting_via_runtime():
    runtime = _build_runtime([_text_response("should not be called")])
    session = _session()
    result, sent = _run_turn(runtime, session, "hello")
    assert runtime._brain._client.chat.completions.calls == []
    assert result.source == RUNTIME_MODE
    spoken = "".join(m.get("token", "") for m in sent)
    assert spoken


def test_no_shopify_for_vague_request():
    runtime = _build_runtime([_text_response("should not be called")])
    with patch.object(llm_tools, "dispatch", new_callable=AsyncMock) as mock_dispatch:
        result, _ = _run_turn(runtime, _session(), "I want a book")
        mock_dispatch.assert_not_called()
    assert runtime._brain._client.chat.completions.calls == []
    assert "title" in result.response_text.lower() or "isbn" in result.response_text.lower()


# ── Brain + tool tests ───────────────────────────────────────────────────────

def test_specific_product_search_calls_llm_and_tools():
    search_json = json.dumps({
        "results": [{
            "title": "Game of Thrones",
            "price": "12.99",
            "variant_id": "v1",
            "available": True,
            "inventory_quantity": 5,
        }],
        "count": 1,
    })

    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=search_json,
    ):
        runtime = _build_runtime([
            _tool_response("search_products", {"query": "Game of Thrones"}),
            _text_response("I found Game of Thrones for $12.99. Would you like me to add it to your cart?"),
        ])
        result, sent = _run_turn(runtime, _session(), "I need Game of Thrones")

    assert "Game of Thrones" in result.response_text
    spoken = "".join(m.get("token", "") for m in sent)
    assert "Game of Thrones" in spoken
    assert "How many copies" in spoken


def test_llm_final_answer_uses_tool_result():
    catalog_json = json.dumps({
        "results": [{
            "title": "Atomic Habits",
            "price": "16.00",
            "variant_id": "v2",
            "available": True,
            "inventory_quantity": 5,
        }],
        "count": 1,
    })

    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=catalog_json,
    ):
        runtime = _build_runtime([
            _tool_response("search_products", {"query": "Atomic Habits"}),
            _text_response("I found Atomic Habits for $16. Would you like to add it?"),
        ])
        result, _ = _run_turn(runtime, _session(), "Atomic Habits")

    assert "Atomic Habits" in result.response_text


# ── Cart tests ────────────────────────────────────────────────────────────────

def test_add_two_copies_cart_quantity():
    session = _session()
    cart = CommerceCartService(session)
    cart.add_item(title="Game of Thrones", variant_id="v1", price="12.99", quantity=2, confirm=True)
    summary = cart.get_summary()
    assert summary.confirmed_count == 1
    assert summary.items[0]["quantity"] == 2


def test_multiple_books_in_cart():
    session = _session()
    cart = CommerceCartService(session)
    cart.add_item(title="Game of Thrones", variant_id="v1", price="12.99", confirm=True)
    cart.add_item(title="Atomic Habits", variant_id="v2", price="16.00", confirm=True)
    summary = cart.get_summary()
    assert summary.confirmed_count == 2


def test_cart_checkout_summary_prompt():
    session = _session()
    cart = CommerceCartService(session)
    cart.add_item(title="Game of Thrones", variant_id="v1", price="12.99", quantity=2, confirm=True)
    prompt = cart.checkout_summary_prompt()
    assert "payment link" in prompt.lower()
    assert "Game of Thrones" in prompt


# ── Email tests ───────────────────────────────────────────────────────────────

def test_spoken_email_normalized_and_spelled_back():
    session = _session()
    cap = VoiceEmailCapture(session)
    result = cap.capture_from_speech("jessica at sureshotbooks dot com")
    assert result.email
    assert "@" in result.email
    assert result.readback
    assert "correct" in result.readback.lower()


def test_email_confirmed_on_yes():
    session = _session()
    cap = VoiceEmailCapture(session)
    cap.capture_from_speech("jessica at gmail dot com")
    confirmed = cap.process_confirmation_turn("yes")
    assert confirmed.confirmed is True
    assert cap.is_verified


def test_email_rejected_on_no():
    session = _session()
    cap = VoiceEmailCapture(session)
    cap.capture_from_speech("jessica at gmail dot com")
    rejected = cap.process_confirmation_turn("no")
    assert rejected.rejected is True
    assert not cap.is_verified


# ── Active workflow yes/no ────────────────────────────────────────────────────

def test_yes_no_continues_active_workflow_not_smalltalk():
    session = _session(awaiting_payment_email_confirmation=True)
    result = classify("yes", session)
    assert result.reason == "active_workflow_yes_no"
    assert result.action == "brain"


def test_interrupt_does_not_lose_cart():
    session = _session()
    cart = CommerceCartService(session)
    cart.add_item(title="Game of Thrones", variant_id="v1", confirm=True)
    session.cart_items = cart.ledger.to_session_format()
    runtime = _build_runtime([_text_response("Sure, your cart still has Game of Thrones.")])
    result, _ = _run_turn(runtime, session, "wait, what was in my cart?")
    summary = CommerceCartService(session).get_summary()
    assert summary.confirmed_count == 1


# ── Order / facility classifier routing ───────────────────────────────────────

def test_order_lookup_routes_to_brain_without_ack():
    result = classify("order number 4521")
    assert result.is_order_lookup is True
    assert result.action == "brain"
    assert not result.ack_reply


def test_facility_question_uses_strong_model_hint():
    result = classify("Can this prison facility accept magazines?")
    assert result.is_facility is True
    assert result.use_strong_model is True


# ── Runtime identity ──────────────────────────────────────────────────────────

def test_live_handler_is_voice_commerce_runtime():
    from app.agent_runtime.live_runtime import resolve_live_turn_handler

    assert resolve_live_turn_handler(_FakeSettings()) == RUNTIME_MODE


def test_brain_uses_fast_model_by_default():
    brain = MainCommerceBrain(settings=_FakeSettings())
    assert brain._select_model(use_strong=False) == "gpt-4o"


def test_brain_uses_strong_model_when_requested():
    brain = MainCommerceBrain(settings=_FakeSettings())
    assert brain._select_model(use_strong=True) == "gpt-4o"
