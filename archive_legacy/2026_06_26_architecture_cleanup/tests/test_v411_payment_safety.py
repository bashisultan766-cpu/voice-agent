"""
v4.1.1 tests — PaymentSafetyGuard, confirmed_email enforcement across all payment paths.

Tests:
 1. send_payment_link_email_tool refuses raw unconfirmed email (no session/confirmed_email)
 2. send_payment_link_email_tool refuses pending_email (has pending but not confirmed)
 3. send_payment_link_email_tool accepts when arg matches confirmed_email
 4. send_payment_link_email_tool blocks if tool arg email differs from confirmed_email
 5. PaymentEmailWorker accepts confirmed_email (integration with safety guard)
 6. PaymentEmailWorker refuses rejected email candidate
 7. create_checkout_link refuses if no items (session present)
 8. create_checkout_link refuses if quantity = 0
 9. create_checkout_link refuses if email arg is rejected candidate
10. No duplicate draft orders (session.pending_checkout_url set → duplicate)
11. "no that's not correct" clears pending email, stores in rejected_candidates
12. "yes that's correct" promotes pending to confirmed
13. No full email in logs (_mask_email works)
14. No worker in app/payment/ imports openai
15. validate_tool_email_arg blocks rejected candidate
"""
from __future__ import annotations

import ast
import os
import pathlib

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("PUBLIC_BASE_URL", "https://test.example.com")


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_session(*, confirmed_email="", pending_email="", rejected=None, checkout_url=""):
    from app.state.models import SessionState
    s = SessionState(
        session_id="sess-v411",
        call_sid="CA00000411",
        from_number="+15550001234",
        to_number="+15559998888",
    )
    s.confirmed_email = confirmed_email
    s.pending_email = pending_email
    s.rejected_email_candidates = list(rejected or [])
    s.pending_checkout_url = checkout_url
    if confirmed_email:
        s.payment_email_confirmed = True
    return s


def _make_settings():
    from unittest.mock import MagicMock
    return MagicMock()


# ── Test 1: send_payment_link_email_tool refuses when no session ──────────────

class TestSendPaymentLinkEmailTool:
    async def test_refuses_no_session(self):
        from app.tools.shopify_tools import send_payment_link_email_tool
        result_json = await send_payment_link_email_tool(email="anyone@example.com", session=None)
        import json
        result = json.loads(result_json)
        assert result.get("success") is False
        assert "session" in result["error"].lower() or "cannot" in result["error"].lower()

    # Test 2: refuses pending_email (has pending but not confirmed)
    async def test_refuses_pending_email_only(self):
        from app.tools.shopify_tools import send_payment_link_email_tool
        session = _make_session(
            pending_email="pending@example.com",
            checkout_url="https://example.com/pay/1",
        )
        result_json = await send_payment_link_email_tool(email="pending@example.com", session=session)
        import json
        result = json.loads(result_json)
        assert result.get("success") is False
        assert "confirm" in result["error"].lower()

    # Test 3: accepts when arg matches confirmed_email
    async def test_accepts_matching_confirmed_email(self):
        from unittest.mock import AsyncMock, patch
        from app.tools.shopify_tools import send_payment_link_email_tool
        session = _make_session(
            confirmed_email="alice@example.com",
            checkout_url="https://example.com/pay/1",
        )
        mock_send = AsyncMock(return_value={"success": True, "id": "msg-123"})
        with patch("app.tools.shopify_tools.send_payment_link_email", mock_send):
            result_json = await send_payment_link_email_tool(
                email="alice@example.com",
                session=session,
            )
        import json
        result = json.loads(result_json)
        assert result.get("success") is True
        mock_send.assert_awaited_once()
        # Must use confirmed_email, not raw arg
        assert mock_send.call_args.kwargs.get("email") == "alice@example.com"

    # Test 4: blocks if tool arg email differs from confirmed_email
    async def test_blocks_mismatched_email_arg(self):
        from app.tools.shopify_tools import send_payment_link_email_tool
        session = _make_session(
            confirmed_email="alice@example.com",
            checkout_url="https://example.com/pay/1",
        )
        result_json = await send_payment_link_email_tool(
            email="different@example.com",
            session=session,
        )
        import json
        result = json.loads(result_json)
        assert result.get("success") is False
        assert "confirm" in result["error"].lower() or "email" in result["error"].lower()


# ── Test 5 & 6: PaymentEmailWorker with safety guard ─────────────────────────

class TestPaymentEmailWorkerWithGuard:
    async def test_accepts_confirmed_email(self):
        from unittest.mock import AsyncMock, patch
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session(
            confirmed_email="buyer@example.com",
            checkout_url="https://example.com/pay/2",
        )
        mock_send = AsyncMock(return_value={"success": True})
        with patch("app.tools.email_sender.send_payment_link_email", mock_send):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is True
        mock_send.assert_awaited_once()
        assert mock_send.call_args.kwargs.get("email") == "buyer@example.com"

    async def test_refuses_rejected_email_candidate(self):
        from unittest.mock import AsyncMock, patch
        from app.workers.payment_email_worker import PaymentEmailWorker
        worker = PaymentEmailWorker()
        session = _make_session(
            confirmed_email="wrongbefore@example.com",
            rejected=["wrongbefore@example.com"],
            checkout_url="https://example.com/pay/3",
        )
        # confirmed_email is in rejected_candidates — PaymentEmailWorker should not send
        # (Guard: confirmed_email being in rejected_candidates means it was cleared)
        # Simulate the corrected state: confirmed_email is gone but rejected candidate remains
        session.confirmed_email = ""
        mock_send = AsyncMock(return_value={"success": True})
        with patch("app.tools.email_sender.send_payment_link_email", mock_send):
            result = await worker.run(session, {}, _make_settings())
        assert result.success is False
        mock_send.assert_not_awaited()


# ── Test 7 & 8 & 9: create_checkout_link cart gating ──────────────────────────

class TestCreateCheckoutLinkGating:
    async def test_refuses_no_items_with_session(self):
        from app.tools.shopify_tools import create_checkout_link
        session = _make_session()
        # session.cart_items is empty
        result_json = await create_checkout_link(items=[], session=session)
        import json
        result = json.loads(result_json)
        assert result.get("success") is not True
        assert "error" in result

    async def test_refuses_zero_quantity(self):
        from app.tools.shopify_tools import create_checkout_link
        session = _make_session()
        session.cart_items = [{"variant_id": "gid://shopify/Variant/1", "quantity": 0, "title": "Test Book"}]
        result_json = await create_checkout_link(
            items=[{"variant_id": "gid://shopify/Variant/1", "quantity": 0}],
            session=session,
        )
        import json
        result = json.loads(result_json)
        assert result.get("success") is False
        assert "quantity" in result["error"].lower()

    async def test_refuses_rejected_email_candidate(self):
        from app.tools.shopify_tools import create_checkout_link
        session = _make_session(rejected=["bad@example.com"])
        session.cart_items = [{"variant_id": "gid://shopify/Variant/1", "quantity": 1, "title": "Book"}]
        result_json = await create_checkout_link(
            items=[{"variant_id": "gid://shopify/Variant/1", "quantity": 1}],
            email="bad@example.com",
            session=session,
        )
        import json
        result = json.loads(result_json)
        assert result.get("success") is False
        assert "confirmed" in result["error"].lower() or "email" in result["error"].lower()


# ── Test 10: No duplicate draft orders ────────────────────────────────────────

class TestNoDuplicateDraftOrders:
    async def test_duplicate_returns_existing_url(self):
        from app.tools.shopify_tools import create_checkout_link
        session = _make_session(checkout_url="https://example.com/existing")
        session.pending_draft_order_id = "D-999"
        session.cart_items = [{"variant_id": "gid://shopify/Variant/1", "quantity": 1, "title": "Book"}]
        result_json = await create_checkout_link(
            items=[{"variant_id": "gid://shopify/Variant/1", "quantity": 1}],
            session=session,
        )
        import json
        result = json.loads(result_json)
        assert result.get("success") is True
        assert result.get("duplicate") is True
        assert result.get("checkout_url") == "https://example.com/existing"


# ── Test 11 & 12: Email correction/confirmation state machine ─────────────────

class TestEmailStateMachine:
    def test_correction_stores_rejected_candidate(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA2",
            from_number="+1", to_number="+2",
        )
        session.pending_email = "wrong@example.com"
        intent = IntentResult(intent="email_correction", confidence=0.9, entities={})
        _apply_email_state(session, intent)
        assert session.pending_email == ""
        assert "wrong@example.com" in session.rejected_email_candidates

    def test_correction_no_duplicates_in_rejected(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA3",
            from_number="+1", to_number="+2",
        )
        session.pending_email = "dup@example.com"
        session.rejected_email_candidates = ["dup@example.com"]
        intent = IntentResult(intent="email_correction", confidence=0.9, entities={})
        _apply_email_state(session, intent)
        assert session.rejected_email_candidates.count("dup@example.com") == 1

    def test_confirmation_promotes_pending_to_confirmed(self):
        from app.pipeline.engine import _apply_email_state
        from app.pipeline.router import IntentResult
        from app.state.models import SessionState
        session = SessionState(
            session_id="s", call_sid="CA4",
            from_number="+1", to_number="+2",
        )
        session.pending_email = "good@example.com"
        intent = IntentResult(intent="email_confirmation", confidence=0.95, entities={})
        _apply_email_state(session, intent)
        assert session.confirmed_email == "good@example.com"
        assert session.pending_email == ""


# ── Test 13: No full email in logs ────────────────────────────────────────────

class TestEmailMaskingInLogs:
    def test_mask_email_hides_local_part(self):
        from app.payment.safety import _mask_email
        masked = _mask_email("jessica@sureshotbooks.com")
        assert "jessica" not in masked
        assert "@sureshotbooks.com" in masked
        assert masked.startswith("j")

    def test_mask_email_short_local(self):
        from app.payment.safety import _mask_email
        masked = _mask_email("a@example.com")
        assert "a@example.com" not in masked or masked.startswith("***")

    def test_mask_email_no_at(self):
        from app.payment.safety import _mask_email
        assert _mask_email("notanemail") == "***@***"


# ── Test 14: No OpenAI import in payment module ───────────────────────────────

class TestNoOpenAIInPaymentModule:
    def test_payment_safety_does_not_import_openai(self):
        payment_dir = pathlib.Path("app/payment")
        for py_file in payment_dir.glob("*.py"):
            src = py_file.read_text(encoding="utf-8")
            tree = ast.parse(src)
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    names = (
                        [a.name for a in node.names]
                        if isinstance(node, ast.Import)
                        else [node.module or ""]
                    )
                    for name in names:
                        assert "openai" not in (name or ""), (
                            f"{py_file} imports openai — payment module must stay LLM-free"
                        )


# ── Test 15: validate_tool_email_arg blocks rejected candidate ─────────────────

class TestValidateToolEmailArg:
    def test_blocks_rejected_candidate(self):
        from app.payment.safety import validate_tool_email_arg
        session = _make_session(
            confirmed_email="good@example.com",
            rejected=["bad@example.com"],
        )
        result = validate_tool_email_arg("bad@example.com", session)
        assert result.allowed is False
        assert result.reason == "rejected_candidate"

    def test_blocks_case_insensitive_rejected(self):
        from app.payment.safety import validate_tool_email_arg
        session = _make_session(
            confirmed_email="good@example.com",
            rejected=["Bad@Example.com"],
        )
        result = validate_tool_email_arg("bad@example.com", session)
        assert result.allowed is False
        assert result.reason == "rejected_candidate"

    def test_allows_matching_confirmed(self):
        from app.payment.safety import validate_tool_email_arg
        session = _make_session(confirmed_email="alice@example.com")
        result = validate_tool_email_arg("alice@example.com", session)
        assert result.allowed is True
        assert result.reason == "email_ok"

    def test_blocks_mismatch(self):
        from app.payment.safety import validate_tool_email_arg
        session = _make_session(confirmed_email="alice@example.com")
        result = validate_tool_email_arg("bob@example.com", session)
        assert result.allowed is False
        assert result.reason == "email_mismatch"

    def test_allows_empty_arg_with_confirmed(self):
        from app.payment.safety import validate_tool_email_arg
        session = _make_session(confirmed_email="alice@example.com")
        result = validate_tool_email_arg(None, session)
        assert result.allowed is True

    def test_blocks_no_confirmed_email(self):
        from app.payment.safety import validate_tool_email_arg
        session = _make_session()
        result = validate_tool_email_arg("anyone@example.com", session)
        assert result.allowed is False
        assert result.reason == "no_confirmed_email"
