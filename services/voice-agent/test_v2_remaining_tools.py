"""
Smoke tests for the 6 newly completed V2 tools + full registry verification.
Each tool: main-path mock test + key edge case.
"""
from __future__ import annotations

import asyncio
import sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(__file__).rsplit("\\", 1)[0])

import app.tools  # noqa: E402 — triggers all self-registrations

from app.state.schema import SessionState
from app.tenant.schema import AgentConfig
from app.tools.base import ToolContext
from app.tools.registry import registry
from app.tools.check_order_facility_restrictions import CheckOrderFacilityRestrictionsTool
from app.tools.address_update_instructions import AddressUpdateInstructionsTool
from app.tools.cancel_order_request import CancelOrderRequestTool
from app.tools.escalate_to_customer_service import EscalateToCustomerServiceTool
from app.tools.send_facility_payment_link import SendFacilityPaymentLinkTool
from app.tools.save_caller_name import MockCallerNameStore, SaveCallerNameTool


def _ctx(phone: str = "+15550001234") -> ToolContext:
    config = AgentConfig(
        agent_id="agent-test",
        tenant_id="tenant-test",
        tool_version="v2",
        cs_email="jessica@sureshotbooks.com",
        internal_api_url="",
        internal_api_key="",
    )
    state = SessionState(
        session_id="sess-smoke",
        agent_id="agent-test",
        tenant_id="tenant-test",
        call_sid="CA_smoke",
        from_number=phone,
        to_number="+18005550001",
    )
    return ToolContext(
        session_id="sess-smoke",
        agent_id="agent-test",
        call_sid="CA_smoke",
        from_number=phone,
        agent_config=config,
        session_state=state,
    )


RESULTS: list[tuple[str, str, bool, str]] = []


def _record(tool: str, case: str, passed: bool, detail: str = "") -> None:
    RESULTS.append((tool, case, passed, detail))
    mark = "PASS" if passed else "FAIL"
    print(f"  [{mark}] {tool} - {case}" + (f" ({detail})" if detail else ""))


async def test_check_order_facility_restrictions() -> None:
    tool = CheckOrderFacilityRestrictionsTool()
    ctx = _ctx()

    # Main: order 1230 (fulfilled, paperback+approved publisher) @ Rikers -> all_accepted
    r = await tool.execute(
        {"order_number": "1230", "facility_name": "Rikers Island", "state": "NY"},
        ctx,
    )
    ok = (
        r.success is True
        and r.data["data"]["outcome"] == "all_accepted"
        and "acceptable" in r.voice_summary.lower()
    )
    _record("check_order_facility_restrictions", "main: Rikers + order 1230 -> all_accepted", ok)

    # Edge: order 1234 (shipped, last digit 4 is unfulfilled w/ hardcover) @ Rikers -> not_accepted
    r2 = await tool.execute(
        {"order_number": "1234", "facility_name": "Rikers Island", "state": "NY"},
        ctx,
    )
    ok2 = r2.success is True and r2.data["data"]["outcome"] == "not_accepted"
    _record("check_order_facility_restrictions", "edge: hardcover @ Rikers -> not_accepted", ok2)


async def test_address_update_instructions() -> None:
    tool = AddressUpdateInstructionsTool()
    ctx = _ctx()

    r = await tool.execute({"order_number": "5678"}, ctx)
    ok = (
        r.success is True
        and "Jessica" in r.voice_summary
        and "jessica@sureshotbooks.com" in r.voice_summary
        and "5678" in r.voice_summary
    )
    _record("address_update_instructions", "main: order # + Jessica email instruction", ok)

    r2 = await tool.execute({}, ctx)
    ok2 = r2.success is True and "Jessica" in r2.voice_summary and "5678" not in r2.voice_summary
    _record("address_update_instructions", "edge: no order number — generic instruction", ok2)


async def test_cancel_order_request() -> None:
    tool = CancelOrderRequestTool()
    ctx = _ctx()

    # Main: order 1235 (unfulfilled, last digit 5) → request_submitted
    r = await tool.execute({"order_number": "1235"}, ctx)
    ok = (
        r.success is True
        and r.data["data"]["outcome"] == "request_submitted"
        and r.data["data"]["confirmation_id"]
        and "cancelled" not in r.voice_summary.lower()
        and "submitted" in r.voice_summary.lower()
    )
    _record("cancel_order_request", "main: unfulfilled order -> request_submitted", ok)

    # Edge: order 1230 (shipped, last digit 0) -> not_eligible, never says cancelled
    r2 = await tool.execute({"order_number": "1230"}, ctx)
    ok2 = (
        r2.success is True
        and r2.data["data"]["outcome"] == "not_eligible"
        and "submitted" not in r2.voice_summary.lower()
        and "cannot" in r2.voice_summary.lower()
    )
    _record("cancel_order_request", "edge: shipped order -> not_eligible", ok2)


async def test_escalate_to_customer_service() -> None:
    tool = EscalateToCustomerServiceTool()
    ctx = _ctx()

    r = await tool.execute({"reason": "Facility approval unknown", "order_number": "9999"}, ctx)
    ok = (
        r.success is True
        and r.data["data"]["escalated"] is True
        and r.data["data"]["ticket_id"].startswith("ESC-")
        and "flagged" in r.voice_summary.lower()
    )
    _record("escalate_to_customer_service", "main: escalation logged with ticket ID", ok)

    async def _stub_fail(*_a, **_k):
        from app.tools.escalate_to_customer_service import EscalationData
        return EscalationData(
            ticket_id="ESC-FAIL",
            reason="test",
            escalated=False,
            mode="stub",
        )

    with patch("app.tools.escalate_to_customer_service._escalation_stub", new=_stub_fail):
        r2 = await tool.execute({"reason": "Test failure"}, ctx)
    ok2 = r2.success is False and r2.data["data"]["escalated"] is False
    _record("escalate_to_customer_service", "edge: escalated=False -> success=False", ok2)


async def test_send_facility_payment_link() -> None:
    tool = SendFacilityPaymentLinkTool()
    ctx = _ctx()
    args = {
        "order_number": "1235",
        "email": "jessica@example.com",
        "email_confirmed": True,
    }

    r = await tool.execute(args, ctx)
    ok = (
        r.success is True
        and r.data["data"]["email_sent"] is True
        and "sent" in r.voice_summary.lower()
    )
    _record("send_facility_payment_link", "main: email_confirmed -> email_sent=True", ok)

    async def _email_fail(*_a, **_k):
        return False

    with patch("app.tools.send_facility_payment_link._email_stub", new=_email_fail):
        r2 = await tool.execute(args, ctx)
    ok2 = (
        r2.success is False
        and r2.data["data"]["email_sent"] is False
        and "wasn't able" in r2.voice_summary.lower()
    )
    _record("send_facility_payment_link", "edge: email stub fails -> success=False", ok2)


async def test_save_caller_name() -> None:
    tool = SaveCallerNameTool()
    phone = "+15559998877"
    ctx = _ctx(phone=phone)

    r = await tool.execute({"name": "Marcus Williams"}, ctx)
    persisted = MockCallerNameStore.get(phone) == "Marcus Williams"
    ok = (
        r.success is True
        and r.data["data"]["saved"] is True
        and r.data["data"]["persisted"] is True
        and r.data["data"]["first_name"] == "Marcus"
        and persisted
    )
    _record("save_caller_name", "main: name saved and verified in mock store", ok)

    r2 = await tool.execute({"name": ""}, ctx)
    ok2 = r2.success is False
    _record("save_caller_name", "edge: empty name -> validation failure", ok2)


async def main() -> None:
    print("\n=== V2 Remaining Tools Smoke Tests ===\n")
    await test_check_order_facility_restrictions()
    await test_address_update_instructions()
    await test_cancel_order_request()
    await test_escalate_to_customer_service()
    await test_send_facility_payment_link()
    await test_save_caller_name()

    names = sorted(registry.all_names())
    print(f"\n=== Registry ({len(names)} tools) ===")
    for n in names:
        print(f"  - {n}")

    print("\n=== Summary ===")
    print(f"{'Tool':<40} {'Case':<45} {'Result'}")
    print("-" * 95)
    for tool, case, passed, _ in RESULTS:
        print(f"{tool:<40} {case:<45} {'PASS' if passed else 'FAIL'}")

    failed = [r for r in RESULTS if not r[2]]
    if failed:
        print(f"\n{len(failed)} test(s) FAILED.")
        sys.exit(1)
    print(f"\nAll {len(RESULTS)} smoke tests passed. Total tools: {len(names)}.\n")


asyncio.run(main())
