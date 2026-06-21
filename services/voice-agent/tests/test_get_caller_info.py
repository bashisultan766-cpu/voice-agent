"""
Unit tests for tools_v2/get_caller_info.py

Coverage:
    - Pure helpers: _confidence_level, _should_ask_for_name, _mask_phone,
                    _extract_first_name, _build_greeting_hint
    - Request model: GetCallerInfoRequest validation + phone normalisation
    - MockCallerRepository: all 10 scenario digits, elapsed_ms, field types
    - _assemble(): typed output for high / medium / low / new scenarios
    - Tool class: name, to_openai_schema()
    - Registry: self-registration on import
    - execute() (async): success paths and validation failure paths

No external I/O, no network calls, no database.
All async tests use asyncio_mode="auto" (pyproject.toml).
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.tools import registry
from app.tools.base import ToolContext, ToolResult
from app.tools.get_caller_info import (
    GetCallerInfoData,
    GetCallerInfoRequest,
    GetCallerInfoTool,
    MockCallerRepository,
    _assemble,
    _build_greeting_hint,
    _confidence_level,
    _extract_first_name,
    _mask_phone,
    _should_ask_for_name,
)
from app.state.schema import SessionState
from app.tenant.schema import AgentConfig


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — shared fixtures
# ─────────────────────────────────────────────────────────────────────────────


def _make_context(
    phone: str = "+15551234560",
    caller_name: str | None = None,
) -> ToolContext:
    """Minimal ToolContext for execute() tests. No real credentials needed."""
    config = AgentConfig(
        agent_id="agent-test",
        tenant_id="tenant-test",
        tool_version="v2",
        internal_api_url="",   # empty → mock path always taken
        internal_api_key="",
    )
    state = SessionState(
        session_id="sess-001",
        agent_id="agent-test",
        tenant_id="tenant-test",
        call_sid="CA123",
        from_number=phone,
        to_number="+18005550001",
        caller_name=caller_name,
    )
    return ToolContext(
        session_id="sess-001",
        agent_id="agent-test",
        call_sid="CA123",
        from_number=phone,
        agent_config=config,
        session_state=state,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. _confidence_level — boundary tests
# ─────────────────────────────────────────────────────────────────────────────


class TestConfidenceLevel:
    def test_high_at_1_0(self):
        assert _confidence_level(1.0) == "high"

    def test_high_at_boundary(self):
        assert _confidence_level(0.90) == "high"

    def test_medium_just_below_high(self):
        assert _confidence_level(0.89) == "medium"

    def test_medium_midrange(self):
        assert _confidence_level(0.75) == "medium"

    def test_medium_at_boundary(self):
        assert _confidence_level(0.60) == "medium"

    def test_low_just_below_medium(self):
        assert _confidence_level(0.59) == "low"

    def test_low_midrange(self):
        assert _confidence_level(0.45) == "low"

    def test_low_at_boundary(self):
        assert _confidence_level(0.30) == "low"

    def test_unknown_just_below_low(self):
        assert _confidence_level(0.29) == "unknown"

    def test_unknown_at_zero(self):
        assert _confidence_level(0.0) == "unknown"


# ─────────────────────────────────────────────────────────────────────────────
# 2. _should_ask_for_name
# ─────────────────────────────────────────────────────────────────────────────


class TestShouldAskForName:
    def test_new_caller_always_asks(self):
        assert _should_ask_for_name(True, None, 0.0) is True

    def test_new_caller_even_if_name_somehow_known(self):
        assert _should_ask_for_name(True, "Marcus", 0.97) is True

    def test_no_name_asks_regardless_of_confidence(self):
        assert _should_ask_for_name(False, None, 0.97) is True

    def test_name_known_high_confidence_does_not_ask(self):
        assert _should_ask_for_name(False, "Marcus", 0.97) is False

    def test_name_known_exactly_at_boundary_does_not_ask(self):
        assert _should_ask_for_name(False, "Marcus", 0.90) is False

    def test_name_known_just_below_boundary_asks(self):
        # confidence 0.89 requires verbal confirmation
        assert _should_ask_for_name(False, "Marcus", 0.89) is True

    def test_name_known_medium_confidence_asks(self):
        assert _should_ask_for_name(False, "Keisha", 0.82) is True


# ─────────────────────────────────────────────────────────────────────────────
# 3. _mask_phone
# ─────────────────────────────────────────────────────────────────────────────


class TestMaskPhone:
    def test_standard_us_e164(self):
        assert _mask_phone("+15551234567") == "+15***67"

    def test_last_two_digits_visible(self):
        result = _mask_phone("+442071234589")
        assert result.endswith("89")

    def test_prefix_visible(self):
        result = _mask_phone("+15551234567")
        assert result.startswith("+15")

    def test_short_phone_does_not_crash(self):
        result = _mask_phone("+12")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_middle_is_masked(self):
        result = _mask_phone("+15551234567")
        assert "***" in result


# ─────────────────────────────────────────────────────────────────────────────
# 4. _extract_first_name
# ─────────────────────────────────────────────────────────────────────────────


class TestExtractFirstName:
    def test_two_word_name(self):
        assert _extract_first_name("Marcus Williams") == "Marcus"

    def test_single_word_name(self):
        assert _extract_first_name("Keisha") == "Keisha"

    def test_three_word_name(self):
        assert _extract_first_name("Mary Jane Watson") == "Mary"

    def test_none_returns_none(self):
        assert _extract_first_name(None) is None

    def test_empty_string_returns_none(self):
        assert _extract_first_name("") is None

    def test_leading_whitespace_stripped(self):
        assert _extract_first_name("  Marcus Williams") == "Marcus"


# ─────────────────────────────────────────────────────────────────────────────
# 5. _build_greeting_hint
# ─────────────────────────────────────────────────────────────────────────────


class TestBuildGreetingHint:
    def test_new_caller_generic_message(self):
        hint = _build_greeting_hint(True, None, 0.0, "unknown")
        assert "New caller" in hint

    def test_high_confidence_safe_to_address(self):
        hint = _build_greeting_hint(False, "Marcus", 0.97, "high")
        assert "Marcus" in hint
        assert "Safe to address" in hint

    def test_medium_confidence_ask_to_confirm(self):
        hint = _build_greeting_hint(False, "Keisha", 0.82, "medium")
        assert "Keisha" in hint
        assert "confirm" in hint.lower()

    def test_low_confidence_greet_generically(self):
        hint = _build_greeting_hint(False, "Unknown", 0.61, "low")
        assert "generic" in hint.lower() or "ask" in hint.lower()

    def test_no_name_on_record(self):
        hint = _build_greeting_hint(False, None, 0.61, "low")
        assert "name unknown" in hint.lower() or "unknown" in hint.lower()

    def test_returns_string(self):
        hint = _build_greeting_hint(False, "Alex", 0.95, "high")
        assert isinstance(hint, str)
        assert len(hint) > 0


# ─────────────────────────────────────────────────────────────────────────────
# 6. GetCallerInfoRequest — validation and phone normalisation
# ─────────────────────────────────────────────────────────────────────────────


class TestGetCallerInfoRequest:
    def test_e164_accepted_unchanged(self):
        req = GetCallerInfoRequest(phone_number="+15551234567")
        assert req.phone_number == "+15551234567"

    def test_ten_digit_normalised_to_e164(self):
        req = GetCallerInfoRequest(phone_number="5551234567")
        assert req.phone_number == "+15551234567"

    def test_formatted_phone_normalised(self):
        req = GetCallerInfoRequest(phone_number="+1 (555) 123-4567")
        assert req.phone_number == "+15551234567"

    def test_us_11_digit_normalised(self):
        req = GetCallerInfoRequest(phone_number="15551234567")
        assert req.phone_number == "+15551234567"

    def test_international_accepted(self):
        req = GetCallerInfoRequest(phone_number="+442071234567")
        assert req.phone_number.startswith("+44")

    def test_empty_string_raises(self):
        with pytest.raises(ValidationError):
            GetCallerInfoRequest(phone_number="")

    def test_too_short_raises(self):
        with pytest.raises(ValidationError):
            GetCallerInfoRequest(phone_number="123")

    def test_whitespace_only_raises(self):
        with pytest.raises(ValidationError):
            GetCallerInfoRequest(phone_number="   ")


# ─────────────────────────────────────────────────────────────────────────────
# 7. MockCallerRepository — all 10 scenario digits
# ─────────────────────────────────────────────────────────────────────────────


class TestMockCallerRepository:
    def _phone(self, last_digit: str) -> str:
        return f"+1555123456{last_digit}"

    # ── High confidence (digits 0–2) ──────────────────────────────────────────

    @pytest.mark.parametrize("digit", ["0", "1", "2"])
    def test_high_confidence_found(self, digit):
        scenario, _ = MockCallerRepository.get(self._phone(digit))
        assert scenario["found"] is True
        assert scenario["is_new_caller"] is False
        assert scenario["confidence"] >= 0.90
        assert scenario["caller_name"] is not None

    @pytest.mark.parametrize("digit", ["0", "1", "2"])
    def test_high_confidence_has_call_history(self, digit):
        scenario, _ = MockCallerRepository.get(self._phone(digit))
        assert scenario["call_count"] > 1
        assert len(scenario["past_purchases"]) > 0

    # ── Medium confidence (digits 3–5) ────────────────────────────────────────

    @pytest.mark.parametrize("digit", ["3", "4", "5"])
    def test_medium_confidence_found(self, digit):
        scenario, _ = MockCallerRepository.get(self._phone(digit))
        assert scenario["found"] is True
        assert scenario["is_new_caller"] is False
        assert 0.60 <= scenario["confidence"] < 0.90
        assert scenario["caller_name"] is not None

    # ── Low confidence (digits 6–7) ───────────────────────────────────────────

    @pytest.mark.parametrize("digit", ["6", "7"])
    def test_low_confidence_no_name(self, digit):
        scenario, _ = MockCallerRepository.get(self._phone(digit))
        assert scenario["found"] is True
        assert scenario["is_new_caller"] is False
        assert 0.30 <= scenario["confidence"] < 0.90
        assert scenario["caller_name"] is None

    # ── New caller (digits 8–9) ───────────────────────────────────────────────

    @pytest.mark.parametrize("digit", ["8", "9"])
    def test_new_caller_not_found(self, digit):
        scenario, _ = MockCallerRepository.get(self._phone(digit))
        assert scenario["found"] is False
        assert scenario["is_new_caller"] is True
        assert scenario["confidence"] == 0.0
        assert scenario["caller_name"] is None
        assert scenario["call_count"] == 0

    # ── Timing and type checks ────────────────────────────────────────────────

    @pytest.mark.parametrize("digit", ["0", "3", "6", "9"])
    def test_elapsed_ms_is_non_negative(self, digit):
        _, elapsed_ms = MockCallerRepository.get(self._phone(digit))
        assert elapsed_ms >= 0.0

    @pytest.mark.parametrize("digit", ["0", "3", "6", "9"])
    def test_elapsed_ms_is_float(self, digit):
        _, elapsed_ms = MockCallerRepository.get(self._phone(digit))
        assert isinstance(elapsed_ms, float)

    def test_scenario_has_required_keys(self):
        scenario, _ = MockCallerRepository.get("+15551234560")
        required = {
            "found", "is_new_caller", "caller_name", "call_count",
            "last_call_date", "past_purchases", "preferred_language",
            "confidence", "confidence_reason",
        }
        assert required.issubset(scenario.keys())


# ─────────────────────────────────────────────────────────────────────────────
# 8. _assemble — typed output correctness
# ─────────────────────────────────────────────────────────────────────────────


class TestAssemble:
    def _get(self, last_digit: str) -> tuple[dict, float]:
        return MockCallerRepository.get(f"+1555123456{last_digit}")

    def test_high_confidence_output(self):
        scenario, ms = self._get("0")
        data = _assemble(scenario, ms, "+15551234560", "mock")

        assert isinstance(data, GetCallerInfoData)
        assert data.found is True
        assert data.is_new_caller is False
        assert data.caller_name == "Marcus Williams"
        assert data.first_name == "Marcus"
        assert data.confidence_level == "high"
        assert data.should_ask_for_name is False
        assert "Marcus" in data.greeting_hint
        assert data.metadata.source == "mock"
        assert data.metadata.phone_e164 == "+15551234560"
        assert "***" in data.metadata.phone_log_safe
        assert data.metadata.lookup_ms >= 0.0

    def test_medium_confidence_output(self):
        scenario, ms = self._get("3")
        data = _assemble(scenario, ms, "+15551234563", "mock")

        assert data.confidence_level == "medium"
        assert data.should_ask_for_name is True   # medium requires verbal confirm
        assert data.first_name is not None

    def test_low_confidence_no_name(self):
        scenario, ms = self._get("6")
        data = _assemble(scenario, ms, "+15551234566", "mock")

        assert data.confidence_level == "low"
        assert data.caller_name is None
        assert data.first_name is None
        assert data.should_ask_for_name is True

    def test_new_caller_output(self):
        scenario, ms = self._get("9")
        data = _assemble(scenario, ms, "+15551234569", "mock")

        assert data.found is False
        assert data.is_new_caller is True
        assert data.caller_name is None
        assert data.first_name is None
        assert data.call_count == 0
        assert data.last_call_date is None
        assert data.past_purchases == []
        assert data.confidence == 0.0
        assert data.confidence_level == "unknown"
        assert data.should_ask_for_name is True
        assert "New caller" in data.greeting_hint

    def test_preferred_language_default_en(self):
        scenario, ms = self._get("0")
        data = _assemble(scenario, ms, "+15551234560", "mock")
        assert data.preferred_language == "en"

    def test_lookup_ms_rounded_to_3dp(self):
        scenario, ms = self._get("0")
        data = _assemble(scenario, ms, "+15551234560", "mock")
        # Should not have more than 3 decimal places
        assert data.metadata.lookup_ms == round(ms, 3)

    def test_model_dump_serialisable(self):
        scenario, ms = self._get("0")
        data = _assemble(scenario, ms, "+15551234560", "mock")
        dumped = data.model_dump()
        assert isinstance(dumped, dict)
        assert "confidence_level" in dumped
        assert "metadata" in dumped


# ─────────────────────────────────────────────────────────────────────────────
# 9. Tool class structure
# ─────────────────────────────────────────────────────────────────────────────


class TestGetCallerInfoToolClass:
    def setup_method(self):
        self.tool = GetCallerInfoTool()

    def test_name(self):
        assert self.tool.name == "get_caller_info"

    def test_description_not_empty(self):
        assert len(self.tool.description) > 0

    def test_openai_schema_type(self):
        schema = self.tool.to_openai_schema()
        assert schema["type"] == "function"

    def test_openai_schema_function_name(self):
        schema = self.tool.to_openai_schema()
        assert schema["function"]["name"] == "get_caller_info"

    def test_openai_schema_has_phone_parameter(self):
        schema = self.tool.to_openai_schema()
        props = schema["function"]["parameters"]["properties"]
        assert "phone_number" in props

    def test_openai_schema_phone_required(self):
        schema = self.tool.to_openai_schema()
        assert "phone_number" in schema["function"]["parameters"]["required"]

    def test_openai_schema_phone_type_string(self):
        schema = self.tool.to_openai_schema()
        assert schema["function"]["parameters"]["properties"]["phone_number"]["type"] == "string"


# ─────────────────────────────────────────────────────────────────────────────
# 10. Registry self-registration
# ─────────────────────────────────────────────────────────────────────────────


class TestRegistration:
    def test_tool_is_registered(self):
        tool = registry.get("get_caller_info")
        assert tool is not None

    def test_registered_tool_is_correct_type(self):
        tool = registry.get("get_caller_info")
        assert isinstance(tool, GetCallerInfoTool)

    def test_tool_appears_in_all_names(self):
        assert "get_caller_info" in registry.all_names()

    def test_schema_available_from_registry(self):
        schemas = registry.get_schemas(["get_caller_info"])
        names = [s["function"]["name"] for s in schemas]
        assert "get_caller_info" in names


# ─────────────────────────────────────────────────────────────────────────────
# 11. execute() — async integration tests (mock path only)
# ─────────────────────────────────────────────────────────────────────────────


class TestExecuteAsync:
    """
    All tests go through the real execute() method using MockCallerRepository.
    USE_REAL_CALLER_DB = False, so no external I/O occurs.
    """

    # ── High confidence (digit 0) ─────────────────────────────────────────────

    async def test_high_confidence_returns_success(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        assert isinstance(result, ToolResult)
        assert result.success is True

    async def test_high_confidence_voice_summary_empty(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        assert result.voice_summary == ""

    async def test_high_confidence_data_envelope(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        assert result.data["success"] is True
        assert result.data["error"] is None
        assert isinstance(result.data["data"], dict)

    async def test_high_confidence_caller_data_fields(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        caller = result.data["data"]
        assert caller["found"] is True
        assert caller["is_new_caller"] is False
        assert caller["confidence_level"] == "high"
        assert caller["caller_name"] == "Marcus Williams"
        assert caller["first_name"] == "Marcus"
        assert caller["should_ask_for_name"] is False

    async def test_high_confidence_state_update_sets_caller_name(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560", caller_name=None)
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        # first_name should be written to state_update when session has no caller_name
        assert result.state_update is not None
        assert result.state_update.get("caller_name") == "Marcus"

    async def test_state_update_skips_name_if_already_known(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560", caller_name="Marcus")  # already set
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        # Should not overwrite an existing caller_name
        if result.state_update:
            assert "caller_name" not in result.state_update

    # ── New caller (digit 9) ──────────────────────────────────────────────────

    async def test_new_caller_returns_success(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234569")
        result = await tool.execute({"phone_number": "+15551234569"}, ctx)

        assert result.success is True

    async def test_new_caller_found_is_false(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234569")
        result = await tool.execute({"phone_number": "+15551234569"}, ctx)

        assert result.data["data"]["found"] is False
        assert result.data["data"]["is_new_caller"] is True

    async def test_new_caller_no_name_in_state_update(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234569")
        result = await tool.execute({"phone_number": "+15551234569"}, ctx)

        # New caller has no name — state_update must not invent one
        if result.state_update:
            assert result.state_update.get("caller_name") is None

    async def test_new_caller_message_indicates_no_profile(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234569")
        result = await tool.execute({"phone_number": "+15551234569"}, ctx)

        assert "new caller" in result.data["message"].lower()

    # ── 10-digit input normalised in execute() ────────────────────────────────

    async def test_10_digit_phone_accepted(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "5551234560"}, ctx)
        assert result.success is True

    async def test_formatted_phone_accepted(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+1 (555) 123-4560"}, ctx)
        assert result.success is True

    # ── Validation failure paths ──────────────────────────────────────────────

    async def test_empty_phone_returns_failure(self):
        tool = GetCallerInfoTool()
        ctx = _make_context()
        result = await tool.execute({"phone_number": ""}, ctx)

        assert result.success is False
        assert result.data["success"] is False
        assert result.data["error"] is not None

    async def test_too_short_phone_returns_failure(self):
        tool = GetCallerInfoTool()
        ctx = _make_context()
        result = await tool.execute({"phone_number": "12"}, ctx)

        assert result.success is False

    async def test_missing_phone_key_returns_failure(self):
        tool = GetCallerInfoTool()
        ctx = _make_context()
        result = await tool.execute({}, ctx)

        assert result.success is False

    async def test_failure_has_empty_voice_summary(self):
        tool = GetCallerInfoTool()
        ctx = _make_context()
        result = await tool.execute({"phone_number": ""}, ctx)

        # Data tool — voice_summary is always "" (even on failure)
        assert result.voice_summary == ""

    # ── Metadata sanity ───────────────────────────────────────────────────────

    async def test_metadata_source_is_mock(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        assert result.data["data"]["metadata"]["source"] == "mock"

    async def test_metadata_phone_log_safe_is_masked(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        log_safe = result.data["data"]["metadata"]["phone_log_safe"]
        assert "***" in log_safe
        # Full phone must NOT appear in the masked string
        assert "+15551234560" != log_safe

    async def test_metadata_lookup_ms_non_negative(self):
        tool = GetCallerInfoTool()
        ctx = _make_context(phone="+15551234560")
        result = await tool.execute({"phone_number": "+15551234560"}, ctx)

        assert result.data["data"]["metadata"]["lookup_ms"] >= 0.0
