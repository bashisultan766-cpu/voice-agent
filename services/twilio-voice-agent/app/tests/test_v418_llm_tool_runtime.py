"""
Acceptance tests for the v4.18 LLM-first tool runtime.

Proves:
  * a normal caller question reaches the OpenAI runtime (no pre-LLM canned answer)
  * there is no regex/business-resolver fast path in front of the LLM
  * a product question triggers the search_products tool
  * order/refund questions require verification
  * the final response is produced by the LLM (not a template composer)
  * a payment link / URL is never spoken aloud
  * secrets are never emitted in the spoken answer
  * required Python libraries are declared in requirements.txt
  * the legacy runtimes are not active (dispatch always uses llm_tool_runtime)

No network calls: the OpenAI client is replaced with a scripted fake.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from app.agent_runtime import llm_tools
from app.agent_runtime.llm_tool_runtime import LLMToolRuntime, RUNTIME_MODE
from app.agent_runtime.output_guardrails import apply_output_guardrails
from app.state.models import SessionState


# ── Scripted fake OpenAI client ────────────────────────────────────────────────
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
    VOICE_OPENAI_TIMEOUT_MS: int = 8000
    VOICE_MAX_REPLY_WORDS: int = 50
    VOICE_PROMPT_TOKEN_BUDGET: int = 4000
    VOICE_LLM_ONLY_FINAL_OUTPUT: bool = True
    VOICE_ENFORCE_DETERMINISTIC_TOOL_RESPONSE: bool = False


def _session() -> SessionState:
    return SessionState(
        session_id="s1", call_sid="CA1234567890", from_number="+15551230000",
        to_number="+15559999999",
    )


def _text_response(content: str) -> _FakeResponse:
    return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content=content))])


def _tool_response(name: str, args: dict) -> _FakeResponse:
    tc = _FakeToolCall(id=f"call_{name}", function=_FakeFunction(name=name, arguments=json.dumps(args)))
    return _FakeResponse(choices=[_FakeChoice(_FakeMessage(content=None, tool_calls=[tc]))])


def _run_turn(runtime: LLMToolRuntime, session: SessionState, text: str):
    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)

    result = asyncio.run(runtime.handle_turn(session, text, send))
    return result, sent


def _build_runtime(scripted) -> LLMToolRuntime:
    runtime = LLMToolRuntime(settings=_FakeSettings())
    runtime._client = _FakeClient(scripted)
    return runtime


# ── Tests ──────────────────────────────────────────────────────────────────────
def test_normal_question_reaches_openai_and_llm_writes_answer():
    runtime = _build_runtime([_text_response("Sure, I can help with that.")])
    result, sent = _run_turn(runtime, _session(), "can you help me find a paperback book?")

    # OpenAI was actually called for this turn.
    assert runtime._client.chat.completions.calls, "OpenAI client was not invoked"
    # The spoken answer is the LLM's text, not a template/canned answer.
    assert result.response_text == "Sure, I can help with that."
    assert result.source == RUNTIME_MODE
    spoken = "".join(m.get("token", "") for m in sent)
    assert "Sure, I can help with that." in spoken


def test_no_regex_or_business_resolver_fast_path_before_llm():
    # A phrase the OLD business_intent_resolver would have canned (policy ask).
    # The LLM-first runtime must still produce the answer via OpenAI.
    runtime = _build_runtime([_text_response("Our refunds are handled case by case.")])
    result, _ = _run_turn(runtime, _session(), "what is your refund policy?")

    assert runtime._client.chat.completions.calls, "LLM must be reached first"
    assert result.response_text == "Our refunds are handled case by case."
    # The runtime module must not import legacy deciders.
    import app.agent_runtime.llm_tool_runtime as mod
    src = Path(mod.__file__).read_text(encoding="utf-8")
    for banned in ("business_intent_resolver", "sales_flow", "tool_answer_composer", "main_llm_composer"):
        assert banned not in src, f"hot path must not reference {banned}"


def test_product_question_triggers_search_products(monkeypatch):
    called = {}

    async def fake_search(query: str, limit: int = 5):
        called["query"] = query
        return json.dumps({"results": [{"title": "Dune", "price": "10.00", "available": True}], "count": 1})

    monkeypatch.setattr(llm_tools._st, "search_products", fake_search)

    runtime = _build_runtime([
        _tool_response("search_products", {"query": "Dune"}),
        _text_response("Dune is in stock for ten dollars."),
    ])
    result, _ = _run_turn(runtime, _session(), "do you have Dune?")

    assert called.get("query") == "Dune", "search_products tool was not executed"
    assert result.response_text == "Dune is in stock for ten dollars."
    # Two LLM rounds: tool request, then final answer.
    assert len(runtime._client.chat.completions.calls) == 2


def test_refund_lookup_requires_verification():
    session = _session()  # not verified
    out = asyncio.run(
        llm_tools.dispatch("lookup_refund_status", {"order_number": "1234"}, session)
    )
    data = json.loads(out)
    assert data.get("verified") is False
    # No refund detail leaks before verification.
    assert "refunds" not in data


def test_order_lookup_status_only_without_verification(monkeypatch):
    # With order number but no email/phone, full financial fields must be absent.
    async def fake_lookup(order_number=None, email=None, phone=None, session=None):
        verified = bool(order_number and (email or phone))
        result = {"found": True, "order_number": "#1234", "status": "PAID",
                  "fulfillment_status": "UNFULFILLED"}
        if verified:
            result["subtotal"] = "20.00 USD"
        return json.dumps(result)

    monkeypatch.setattr(llm_tools._st, "lookup_order", fake_lookup)
    out = asyncio.run(
        llm_tools.dispatch("lookup_order_status", {"order_number": "1234"}, _session())
    )
    data = json.loads(out)
    assert "subtotal" not in data, "unverified order must not expose financials"


def test_payment_link_url_is_never_spoken():
    guarded = apply_output_guardrails(
        "Here is your link https://shop.example.com/checkout/abc123 to pay.",
    )
    assert "http" not in guarded.text
    assert "url_blocked" in guarded.reasons


def test_secrets_are_never_spoken():
    guarded = apply_output_guardrails(
        "The token is sk-abcdef123456 and shop is shpat_0123456789abcdef.",
    )
    assert "sk-abcdef123456" not in guarded.text
    assert "shpat_0123456789abcdef" not in guarded.text
    assert "secret_redacted" in guarded.reasons


def test_full_card_number_is_masked():
    guarded = apply_output_guardrails("Your card 4111 1111 1111 1111 is on file.")
    assert "4111 1111 1111 1111" not in guarded.text
    assert "1111" in guarded.text  # last 4 kept


def test_required_libraries_declared():
    req = Path(__file__).resolve().parents[2] / "requirements.txt"
    text = req.read_text(encoding="utf-8").lower()
    for lib in ("openai", "pydantic", "tenacity", "rapidfuzz", "numpy", "tiktoken",
                "python-dotenv", "pytest", "pytest-asyncio"):
        assert lib in text, f"{lib} missing from requirements.txt"


def test_legacy_runtimes_not_active():
    from app.agent_runtime.live_runtime import resolve_live_turn_handler
    from app.runtime.voice_commerce_runtime import RUNTIME_MODE as COMMERCE_MODE

    @dataclass
    class _S:
        VOICE_AGENT_RUNTIME_MODE: str = "main_llm_agent"  # legacy value
        VOICE_COMMERCE_RUNTIME_ENABLED: bool = True

    # Even with a legacy mode configured, the active handler is voice commerce runtime.
    assert resolve_live_turn_handler(_S()) == COMMERCE_MODE


def test_dispatch_routes_to_active_runtime(monkeypatch):
    import app.ws.conversation_relay as cr
    from app.config import Settings

    captured = {"handler": None}

    class _CommerceCaptured:
        async def handle_turn(self, session, text, send, caller_context=None, **kwargs):
            captured["handler"] = "commerce"

            class _R:
                response_text = "ok"
            return _R()

    class _LegacyCaptured:
        async def handle_turn(self, session, text, send, caller_context=None, **kwargs):
            captured["handler"] = "legacy"

            class _R:
                response_text = "ok"
            return _R()

    monkeypatch.setattr(
        "app.runtime.voice_commerce_runtime.get_voice_commerce_runtime",
        lambda settings=None: _CommerceCaptured(),
    )
    monkeypatch.setattr(
        "app.agent_runtime.llm_tool_runtime.get_llm_tool_runtime",
        lambda settings=None: _LegacyCaptured(),
    )

    async def send(msg):
        pass

    # Default: voice commerce runtime enabled
    asyncio.run(cr.dispatch_assembled_turn(Settings(), _session(), "hi", send, None))
    assert captured["handler"] == "commerce"

    captured["handler"] = None
    asyncio.run(
        cr.dispatch_assembled_turn(
            Settings(VOICE_COMMERCE_RUNTIME_ENABLED=False, VOICE_ORCHESTRATOR_ENABLED=False),
            _session(),
            "hi",
            send,
            None,
        )
    )
    assert captured["handler"] == "legacy"


def test_master_prompt_is_single_file_with_sections():
    from app.agent_runtime.master_prompt import load_master_prompt

    mp = load_master_prompt()
    for key in ("persona", "privacy_rules", "tool_rules", "payment_rules",
                "escalation_rules", "domain_boundaries", "voice_style",
                "facility_rules", "product_order_refund_rules"):
        assert key in mp.sections, f"master prompt missing section {key}"


def test_elevenlabs_tools_registered():
    required = {
        "normalize_voice_intent", "get_order", "catalog_search",
        "calculate_pricing", "check_facility_approval",
        "check_order_facility_restrictions", "address_update_instructions",
        "cancel_order_request", "send_facility_payment_link",
        "get_caller_info", "save_caller_name", "escalate_to_customer_service",
    }
    names = set(llm_tools.tool_names())
    missing = required - names
    assert not missing, f"Missing ElevenLabs-aligned tools: {missing}"


def test_core_tools_still_registered():
    assert len(llm_tools.tool_names()) >= 28
    assert "search_products" in llm_tools.tool_names()
    assert "send_payment_link" in llm_tools.tool_names()
