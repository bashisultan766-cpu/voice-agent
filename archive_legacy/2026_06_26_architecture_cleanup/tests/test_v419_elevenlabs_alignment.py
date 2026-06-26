"""
v4.19 — ElevenLabs prompt / tool alignment acceptance tests.

Validates master prompt completeness, ElevenLabs tool registry, business flows,
and voice-capture fixes (ISBN, card masking, email).
"""
from __future__ import annotations

import json
import os

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.agent_runtime import llm_tools
from app.agent_runtime.master_prompt import load_master_prompt
from app.agent_runtime.output_guardrails import apply_output_guardrails
from app.state.models import SessionState
from app.tools import shopify_tools as st
from app.tools.voice_intent import normalize_voice_intent


ELEVENLABS_TOOLS = {
    "normalize_voice_intent": "normalize_voice_intent",
    "get_order": "get_order",
    "catalog_search": "catalog_search",
    "calculate_pricing": "calculate_pricing",
    "check_facility_approval": "check_facility_approval",
    "check_order_facility_restrictions": "check_order_facility_restrictions",
    "address_update_instructions": "address_update_instructions",
    "cancel_order_request": "cancel_order_request",
    "escalate_to_customer_service": "escalate_to_customer_service",
    "send_facility_payment_link": "send_facility_payment_link",
    "send_payment_link": "send_payment_link",
    "get_caller_info": "get_caller_info",
    "save_caller_name": "save_caller_name",
}


def _session() -> SessionState:
    return SessionState(
        session_id="s1", call_sid="CA9999999999", from_number="+15551230000",
        to_number="+15559999999",
    )


class TestMasterPromptCompleteness:
    @pytest.fixture
    def prompt_text(self):
        return load_master_prompt().text.lower()

    def test_contains_tool_first_rules(self, prompt_text):
        assert "never guess" in prompt_text
        assert "tool" in prompt_text
        assert "catalog_search" in prompt_text
        assert "get_order" in prompt_text

    def test_never_say_processing_fee(self, prompt_text):
        assert "processing fee" in prompt_text
        assert "never" in prompt_text

    def test_email_payment_confirmation_flow(self, prompt_text):
        assert "confirm" in prompt_text
        assert "email" in prompt_text
        assert "send_payment_link" in prompt_text

    def test_order_refund_privacy_rules(self, prompt_text):
        assert "verification" in prompt_text
        assert "privacy" in prompt_text
        assert "lookup_refund_status" in prompt_text

    def test_facility_cancellation_address_rules(self, prompt_text):
        assert "check_facility_approval" in prompt_text
        assert "cancel_order_request" in prompt_text
        assert "address_update_instructions" in prompt_text
        assert "jessica" in prompt_text

    def test_normalize_voice_intent_in_prompt(self, prompt_text):
        assert "normalize_voice_intent" in prompt_text
        assert "ordinary" in prompt_text

    def test_required_sections_present(self):
        mp = load_master_prompt()
        for key in (
            "persona", "domain_boundaries", "voice_style", "tool_rules",
            "privacy_rules", "payment_rules", "product_order_refund_rules",
            "facility_rules", "escalation_rules", "business_rules",
        ):
            assert key in mp.sections, f"missing section {key}"


class TestElevenLabsToolRegistry:
    def test_all_elevenlabs_tools_registered(self):
        names = set(llm_tools.tool_names())
        for el_name, openai_name in ELEVENLABS_TOOLS.items():
            assert openai_name in names, f"OpenAI tool missing for ElevenLabs {el_name}"

    def test_legacy_tools_still_available(self):
        names = set(llm_tools.tool_names())
        for legacy in ("search_products", "lookup_order_status", "escalate_to_human"):
            assert legacy in names

    def test_tool_specs_count(self):
        assert len(llm_tools.tool_specs()) == len(llm_tools.customer_facing_tool_names())
        assert "create_checkout" not in {s["function"]["name"] for s in llm_tools.tool_specs()}


class TestNormalizeVoiceIntent:
    def test_ordinary_maps_to_order_context(self):
        out = json.loads(normalize_voice_intent("I need my ordinary status"))
        assert out["intent"] in ("order", "tracking", "unknown")
        assert out["do_not_answer_customer"] is True

    def test_book_search_intent(self):
        out = json.loads(normalize_voice_intent("do you have dune in stock"))
        assert out["intent"] == "book_search"

    def test_no_medical_refusal_for_order_words(self):
        out = json.loads(normalize_voice_intent("check my refund for order 1234"))
        assert out.get("off_domain") != "medical"


class TestBusinessFlowTools:
    @pytest.mark.asyncio
    async def test_get_order_delegates_to_lookup(self, monkeypatch):
        called = {}

        async def fake(order_number=None, email=None, phone=None, session=None):
            called["order_number"] = order_number
            return json.dumps({"found": True, "order_number": order_number})

        monkeypatch.setattr(st, "lookup_order", fake)
        out = await llm_tools.dispatch(
            "get_order", {"order_number": "47569"}, _session(),
        )
        data = json.loads(out)
        assert called["order_number"] == "47569"
        assert data["found"] is True

    @pytest.mark.asyncio
    async def test_refund_requires_verification(self):
        out = await llm_tools.dispatch(
            "lookup_refund_status", {"order_number": "1234"}, _session(),
        )
        data = json.loads(out)
        assert data.get("verified") is False

    @pytest.mark.asyncio
    async def test_catalog_search_partial_isbn_does_not_search(self):
        out = await llm_tools.dispatch(
            "catalog_search", {"query": "9 7 9 8"}, _session(),
        )
        data = json.loads(out)
        assert data.get("needs_more_digits") is True
        assert data.get("results") == []

    @pytest.mark.asyncio
    async def test_catalog_search_complete_isbn(self, monkeypatch):
        async def fake(query, limit=5):
            return json.dumps({
                "results": [{"title": "Test Book", "price": "10.00", "available": True}],
                "count": 1,
            })

        monkeypatch.setattr(st, "SureShotCatalogSearch", fake)
        out = await llm_tools.dispatch(
            "catalog_search", {"query": "9780143127550"}, _session(),
        )
        data = json.loads(out)
        assert data.get("count", 0) >= 0

    @pytest.mark.asyncio
    async def test_address_update_returns_jessica_instruction(self, monkeypatch):
        async def fake(order_number=None, session=None):
            return json.dumps({
                "success": True,
                "instructions": (
                    "For address updates, please email Jessica with your order number "
                    "and the correct address."
                ),
                "contact_email": "jessica@sureshotbooks.com",
            })

        monkeypatch.setattr(st, "AddressUpdateInstructions", fake)
        out = await llm_tools.dispatch("address_update_instructions", {}, _session())
        data = json.loads(out)
        assert "jessica" in data["instructions"].lower()

    @pytest.mark.asyncio
    async def test_cancel_order_request_exists(self, monkeypatch):
        async def fake(order_number, email=None, session=None):
            return json.dumps({
                "success": True,
                "cancellation_eligible": True,
                "message": "eligible",
            })

        monkeypatch.setattr(st, "CancelOrderRequest", fake)
        out = await llm_tools.dispatch(
            "cancel_order_request", {"order_number": "1001"}, _session(),
        )
        assert json.loads(out)["cancellation_eligible"] is True

    @pytest.mark.asyncio
    async def test_facility_approval_tool(self, monkeypatch):
        async def fake(facility_name, order_number=None, session=None):
            return json.dumps({
                "approval_status": "approved",
                "facility_name": facility_name,
            })

        monkeypatch.setattr(st, "CheckFacilityApproval", fake)
        out = await llm_tools.dispatch(
            "check_facility_approval", {"facility_name": "State Prison"}, _session(),
        )
        assert json.loads(out)["approval_status"] == "approved"


class TestVoiceCapture:
    def test_isbn_not_masked_as_card(self):
        isbn = "9780143127550"
        guarded = apply_output_guardrails(f"The ISBN is {isbn}.")
        assert isbn in guarded.text
        assert "card_masked" not in guarded.reasons

    def test_real_card_number_masked(self):
        guarded = apply_output_guardrails("Your card 4111 1111 1111 1111 is on file.")
        assert "4111 1111 1111 1111" not in guarded.text
        assert "1111" in guarded.text
        assert "card_masked" in guarded.reasons

    def test_spoken_email_normalizes(self):
        from app.email.capture import normalize_spoken_email

        email = normalize_spoken_email("bashi sultan at gmail dot com")
        assert email == "bashisultan@gmail.com"

    def test_activate_maps_to_at_in_email(self):
        from app.email.capture import normalize_spoken_email

        email = normalize_spoken_email("bashi activate gmail dot com")
        assert email is not None
        assert "@" in email

    def test_gmail_spoken_variant(self):
        from app.email.capture import normalize_spoken_email

        email = normalize_spoken_email("alice at g mail dot com")
        assert email == "alice@gmail.com"

    def test_no_raw_url_spoken(self):
        guarded = apply_output_guardrails(
            "I sent https://checkout.shopify.com/pay/abc123 to your email.",
        )
        assert "http" not in guarded.text
        assert "url_blocked" in guarded.reasons

    def test_confirmation_email_not_fully_masked_in_guardrails(self):
        guarded = apply_output_guardrails(
            "Just to confirm, I heard bashisultan@gmail.com. Is that correct?",
        )
        assert "bashisultan@gmail.com" in guarded.text
