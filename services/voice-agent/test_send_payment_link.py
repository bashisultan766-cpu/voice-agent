"""
Smoke test: send_payment_link — two scenarios.
  (a) email_sent=True  → success=True, suggested_response says link was sent
  (b) email_sent=False → success=False, suggested_response does NOT claim link was sent
"""
import asyncio
import sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(__file__).rsplit("\\", 1)[0])

import app.tools  # noqa: E402 — triggers all tool self-registrations

from app.tools.send_payment_link import SendPaymentLinkTool
from app.tools.base import ToolContext


class _FakeConfig:
    shopify_domain = None
    shopify_access_token = None
    resend_api_key = None
    from_email = "orders@sureshotbooks.com"


class _FakeState:
    caller_verified = False


_ctx = ToolContext(
    session_id="smoke-001",
    agent_id="agent-001",
    call_sid="CA_smoke",
    from_number="+15550001234",
    agent_config=_FakeConfig(),
    session_state=_FakeState(),
)

_args = {
    "email": "jessica@example.com",
    "email_confirmed": True,
    "items": [
        {"variant_id": "var_001", "quantity": 1, "title": "A Thug's Heartbeat", "price": "15.95"},
        {"variant_id": "var_002", "quantity": 2, "title": "Hood Rich", "price": "14.99"},
    ],
}

_tool = SendPaymentLinkTool()


def _print_result(label: str, r) -> None:
    print(f"\n{'=' * 60}")
    print(f"SCENARIO {label}")
    print("=" * 60)
    print(f"  success           : {r.success}")
    print(f"  error             : {r.error}")
    print(f"  state_update      : {r.state_update}")
    print(f"  suggested_response: {r.data.get('suggested_response')}")
    print(f"  voice_summary     : {r.voice_summary}")


async def main() -> None:
    # ── (a) SUCCESS — _email_stub returns True (default behaviour) ────────────
    result_a = await _tool.execute(_args, _ctx)
    _print_result("(a) email_sent=True  [stub returns True]", result_a)
    assert result_a.success is True, "FAIL: expected success=True"
    assert result_a.state_update and result_a.state_update.get("conversation_state") == "CHECKOUT_SENT"
    assert "sent" in result_a.voice_summary.lower() or "sent" in (result_a.data.get("suggested_response") or "").lower()
    assert "wasn't able" not in result_a.voice_summary
    print("  ✓ assertions passed")

    # ── (b) FAILURE — patch _email_stub to return False ───────────────────────
    async def _stub_fail(*_args, **_kwargs) -> bool:
        return False

    with patch("app.tools.send_payment_link._email_stub", new=_stub_fail):
        result_b = await _tool.execute(_args, _ctx)

    _print_result("(b) email_sent=False [stub patched to return False]", result_b)
    assert result_b.success is False, "FAIL: expected success=False"
    assert result_b.state_update and result_b.state_update.get("conversation_state") is None
    assert result_b.state_update.get("email_fsm_state") == "EMAIL_FAILED"
    voice_b = result_b.voice_summary
    assert "sent" not in voice_b or "wasn't able" in voice_b, f"FAIL: voice claims success: {voice_b!r}"
    assert "wasn't able" in voice_b or "trouble" in voice_b
    print("  ✓ assertions passed")

    print("\nAll smoke tests passed.\n")


asyncio.run(main())
