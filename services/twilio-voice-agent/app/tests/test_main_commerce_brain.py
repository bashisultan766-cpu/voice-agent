"""
Tests for Main Commerce Brain — schema validity, tool loop, and routing.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from unittest.mock import AsyncMock, patch

import pytest

from app.agent_runtime import llm_tools
from app.agent_runtime.tool_runtime_gates import gate_tool_call
from app.agents.main_commerce_brain import MainCommerceBrain
from app.agents.openai_request_utils import format_openai_bad_request
from app.agents.openai_tool_schema_adapter import (
    MAIN_BRAIN_TOOL_NAMES,
    get_main_brain_tool_specs,
    validate_main_brain_tool_specs,
)
from app.runtime.fast_classifier import classify
from app.runtime.voice_commerce_runtime import VoiceCommerceRuntime
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
        return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content="Okay."))])


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
    VOICE_TOOL_TIMEOUT_MS: int = 2500
    VOICE_LLM_STREAM_ENABLED: bool = False


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


class _BadRequestError(Exception):
    status_code = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.body = {"error": {"message": message}}


# ── Schema tests ──────────────────────────────────────────────────────────────

def test_main_brain_tool_specs_valid():
    issues = validate_main_brain_tool_specs()
    assert issues == [], f"schema issues: {issues}"


def test_main_brain_tool_specs_json_serializable():
    specs = get_main_brain_tool_specs()
    json.dumps(specs)


def test_main_brain_no_duplicate_tool_names():
    names = [s["function"]["name"] for s in get_main_brain_tool_specs()]
    assert len(names) == len(set(names))


def test_main_brain_excludes_create_checkout():
    names = {s["function"]["name"] for s in get_main_brain_tool_specs()}
    assert "create_checkout" not in names
    assert "send_payment_link" in names


def test_main_brain_tool_count_matches_allowlist():
    specs = get_main_brain_tool_specs()
    assert len(specs) == len(MAIN_BRAIN_TOOL_NAMES)


def test_format_openai_bad_request_safe_details():
    specs = get_main_brain_tool_specs()
    # Inject invalid schema to test detection.
    bad_specs = list(specs)
    bad_specs[0] = {
        "type": "function",
        "function": {
            "name": "bad_tool",
            "description": "x",
            "parameters": {"type": "object", "properties": {"x": []}, "required": []},
        },
    }
    err = _BadRequestError("Invalid schema for function bad_tool")
    detail = format_openai_bad_request(
        err,
        model="gpt-4o-mini",
        messages=[{"role": "system", "content": "hi"}, {"role": "user", "content": "test"}],
        tools=bad_specs,
    )
    assert detail["model"] == "gpt-4o-mini"
    assert detail["messages_count"] == 2
    assert detail["tools_count"] == len(bad_specs)
    assert detail["invalid_tool_schema"]
    assert "sk-" not in detail["error_message"]


# ── Brain tool loop tests ─────────────────────────────────────────────────────

def test_game_of_thrones_requests_search_products():
    catalog_json = json.dumps({
        "results": [{
            "title": "Game of Thrones",
            "price": "12.99",
            "variant_id": "v1",
            "available": True,
            "inventory_quantity": 5,
        }],
        "count": 1,
    })
    runtime = VoiceCommerceRuntime(settings=_FakeSettings())

    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)

    with patch(
        "app.agent_runtime.llm_tools._catalog_search",
        new_callable=AsyncMock,
        return_value=catalog_json,
    ):
        result = asyncio.run(runtime.handle_turn(_session(), "I need the book Game of Thrones", send))

    assert "Game of Thrones" in result.response_text
    assert "12.99" in result.response_text or "12" in result.response_text


def test_tool_result_produces_final_llm_answer():
    brain = MainCommerceBrain(settings=_FakeSettings())
    brain._client = _FakeClient([
        _tool_response("search_products", {"query": "Atomic Habits"}),
        _text_response("I found Atomic Habits for sixteen dollars."),
    ])
    session = _session()

    async def fake_dispatch(name, args, session):
        return json.dumps({"success": True, "results": [{"title": "Atomic Habits", "price": "16.00"}]})

    with patch.object(llm_tools, "dispatch", side_effect=fake_dispatch):
        text, tools, _ = asyncio.run(brain.run_turn(session, "Atomic Habits"))

    assert "search_products" in tools
    assert "Atomic Habits" in text


def test_order_number_requests_lookup_order_status():
    brain = MainCommerceBrain(settings=_FakeSettings())
    brain._client = _FakeClient([
        _tool_response("lookup_order_status", {"order_number": "1234"}),
        _text_response("Order 1234 is being fulfilled."),
    ])
    session = _session()

    async def fake_dispatch(name, args, session):
        return json.dumps({"found": True, "order_number": "1234", "status": "open"})

    with patch.object(llm_tools, "dispatch", side_effect=fake_dispatch):
        text, tools, _ = asyncio.run(brain.run_turn(session, "Check order number 1234"))

    assert "lookup_order_status" in tools
    assert "1234" in text


def test_refund_without_order_asks_verification():
    brain = MainCommerceBrain(settings=_FakeSettings())
    brain._client = _FakeClient([
        _text_response("I can check that. What is your order number or email on the order?"),
    ])
    session = _session()
    text, tools, _ = asyncio.run(brain.run_turn(session, "Did I get a refund?"))
    assert not tools
    assert "order" in text.lower() or "email" in text.lower()


def test_facility_question_calls_facility_tool():
    brain = MainCommerceBrain(settings=_FakeSettings())
    brain._client = _FakeClient([
        _tool_response("check_facility_content_allowed", {
            "facility_name": "Test Facility",
            "content_type": "magazine",
        }),
        _text_response("Magazines are allowed at that facility."),
    ])
    session = _session()

    async def fake_dispatch(name, args, session):
        return json.dumps({"allowed": True, "content_type": "magazine"})

    with patch.object(llm_tools, "dispatch", side_effect=fake_dispatch):
        text, tools, _ = asyncio.run(brain.run_turn(session, "Does this facility allow magazines?"))

    assert any("facility" in t for t in tools)
    assert text


def test_payment_without_email_blocked_by_gate():
    session = _session()
    gate = gate_tool_call("send_payment_link", session)
    assert gate is not None
    assert not gate.allowed


def test_confirmed_cart_and_email_can_send_payment_link():
    session = _session(
        confirmed_email="john@example.com",
        payment_email_confirmed=True,
        email_verified=True,
        payment_cart_confirmed=True,
    )
    from app.cart.session import add_product_candidate, confirm_last_candidate

    add_product_candidate(session, title="Test Book", variant_id="v1", price="10.00")
    confirm_last_candidate(session)
    gate = gate_tool_call("send_payment_link", session)
    assert gate is None or gate.allowed


# ── Fast classifier — no LLM paths ──────────────────────────────────────────

def test_greeting_does_not_call_llm():
    result = classify("Hello, brother. How are you?")
    assert result.action == "instant"
    assert result.skip_llm is True


def test_i_need_a_book_does_not_call_llm():
    result = classify("I need a book.")
    assert result.action == "instant"
    assert result.skip_llm is True


def test_can_i_give_isbn_does_not_call_llm():
    result = classify("Can I give you the ISBN number?")
    assert result.action == "instant"
    assert result.skip_llm is True
    assert "isbn" in result.instant_reply.lower()


def test_partial_isbn_digits_use_deterministic_product_search():
    result = classify("9780747532699")
    assert result.action == "instant"
    assert result.skip_llm is True
    assert result.is_product_search is True


def test_openai_failure_never_causes_silence():
    brain = MainCommerceBrain(settings=_FakeSettings())

    class _FailingCompletions:
        async def create(self, **kwargs):
            raise _BadRequestError("Invalid schema")

    brain._client = type("C", (), {"chat": type("Ch", (), {"completions": _FailingCompletions()})()})()
    text, _, _ = asyncio.run(brain.run_turn(_session(), "Game of Thrones"))
    assert text
    assert "trouble" in text.lower() or "isbn" in text.lower()


def test_tool_failure_never_causes_silence():
    brain = MainCommerceBrain(settings=_FakeSettings())
    brain._client = _FakeClient([
        _tool_response("search_products", {"query": "Missing Book"}),
        _text_response("Sorry, I could not find that book. Want to try another title?"),
    ])
    session = _session()

    async def failing_dispatch(name, args, session):
        return json.dumps({"success": False, "error": "Shopify unavailable"})

    with patch.object(llm_tools, "dispatch", side_effect=failing_dispatch):
        text, tools, _ = asyncio.run(brain.run_turn(session, "Missing Book XYZ"))

    assert tools
    assert text


def test_final_response_short_and_phone_friendly():
    brain = MainCommerceBrain(settings=_FakeSettings())
    long_text = " ".join(["word"] * 80)
    final = brain.finalize_response(_session(), long_text, [])
    assert len(final.split()) <= 50
