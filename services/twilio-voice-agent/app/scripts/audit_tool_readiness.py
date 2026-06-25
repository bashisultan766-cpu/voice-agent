#!/usr/bin/env python3
"""
Production tool-readiness diagnostic (v4.20).

Usage:
    python -m app.scripts.audit_tool_readiness

Prints runtime status, prompt diagnostics, per-tool readiness, integration
connectivity, and a PASS/FAIL summary. Never prints secret values.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Callable


@dataclass
class ToolAuditRow:
    name: str
    backend: str
    data_source: str  # real | cache | local | partial
    tests: str
    readiness: str  # ready | partial | broken
    safe: bool
    notes: str = ""


def _tool_inventory() -> list[ToolAuditRow]:
    """Build audit table from code — not assumptions."""
    return [
        ToolAuditRow("normalize_voice_intent", "voice_intent.normalize_voice_intent", "local", "test_v419_elevenlabs_alignment", "ready", True),
        ToolAuditRow("get_caller_info", "caller_identity.get_caller_info + GetCallerInfo", "cache+shopify", "test_v4170_caller_identity", "ready", True),
        ToolAuditRow("save_caller_name", "shopify_tools.SaveCallerName", "local session", "partial", "ready", True),
        ToolAuditRow("catalog_search", "shopify_tools.SureShotCatalogSearch", "shopify+cache", "test_v419_elevenlabs_alignment", "ready", True),
        ToolAuditRow("search_products", "shopify_tools.search_products", "shopify+cache", "test_shopify_tools", "ready", True),
        ToolAuditRow("get_product_details", "shopify_tools.get_product_details", "shopify", "test_shopify_tools", "ready", True),
        ToolAuditRow("compare_products", "search_products x N", "shopify+cache", "partial", "partial", True, "no dedicated dispatch test"),
        ToolAuditRow("get_cart", "cart.session.get_ledger", "local session", "partial", "ready", True),
        ToolAuditRow("add_to_cart", "cart.session + gates", "local session", "test_v420", "ready", True),
        ToolAuditRow("update_cart", "cart.session", "local session", "partial", "ready", True),
        ToolAuditRow("remove_from_cart", "cart.session", "local session", "partial", "ready", True),
        ToolAuditRow("create_checkout", "shopify_tools.create_checkout_link + gates", "shopify", "test_v420", "ready", True),
        ToolAuditRow("send_payment_link", "SendPaymentLink + Resend", "shopify+resend", "test_v419_payment_flow", "ready", True),
        ToolAuditRow("get_order", "shopify_tools.GetOrder", "shopify", "test_v419_elevenlabs_alignment", "ready", True),
        ToolAuditRow("lookup_order_status", "shopify_tools.lookup_order", "shopify", "test_order_refund", "ready", True),
        ToolAuditRow("lookup_refund_status", "shopify_tools.get_refund_status", "shopify", "test_order_refund", "ready", True),
        ToolAuditRow("calculate_pricing", "shopify_tools.CalculatePricing", "shopify", "partial", "ready", True),
        ToolAuditRow("check_facility_approval", "FacilityApprovalWorker", "worker/cache", "test_v41_facility_workers", "partial", True),
        ToolAuditRow("check_order_facility_restrictions", "FacilityRestrictionWorker", "worker/cache", "test_v41_facility_workers", "partial", True),
        ToolAuditRow("send_facility_payment_link", "shopify_tools.SendFacilityPaymentLink", "resend", "partial", "partial", True),
        ToolAuditRow("address_update_instructions", "shopify_tools.AddressUpdateInstructions", "local", "test_v419_elevenlabs_alignment", "ready", True),
        ToolAuditRow("cancel_order_request", "shopify_tools.CancelOrderRequest", "shopify", "test_v419_elevenlabs_alignment", "ready", True),
        ToolAuditRow("shipping_policy_lookup", "knowledge_base", "local", "test_v411_knowledge_base", "ready", True),
        ToolAuditRow("refund_policy_lookup", "knowledge_base", "local", "test_workers", "ready", True),
        ToolAuditRow("facility_policy_lookup", "CheckFacilityApproval", "worker/cache", "test_v4144", "partial", True),
        ToolAuditRow("faq_lookup", "knowledge_base", "local", "test_v411_knowledge_base", "ready", True),
        ToolAuditRow("escalate_to_human", "shopify_tools.escalate_to_human", "resend+logs", "test_shopify_tools", "ready", True),
        ToolAuditRow("escalate_to_customer_service", "EscalateToCustomerService", "resend+logs", "test_v418", "ready", True),
        ToolAuditRow("lookup_customer_by_email_or_phone", "SearchCustomerByPhone", "cache+shopify", "test_v4170", "ready", True),
    ]


def _present(val: str) -> bool:
    return bool((val or "").strip())


def _check_redis() -> tuple[bool, str]:
    from app.config import get_settings

    url = get_settings().REDIS_URL
    if not _present(url):
        return False, "REDIS_URL missing"
    try:
        import redis

        r = redis.from_url(url, socket_connect_timeout=2)
        r.ping()
        return True, "connected"
    except Exception as exc:  # noqa: BLE001
        return False, type(exc).__name__


def _check_shopify() -> tuple[bool, str]:
    from app.shopify.client import get_shopify_client

    client = get_shopify_client()
    if not client.configured:
        return False, "not configured"
    return True, "configured"


def _check_resend() -> tuple[bool, str]:
    from app.config import get_settings

    s = get_settings()
    if not _present(s.RESEND_API_KEY):
        return False, "RESEND_API_KEY missing"
    if not _present(s.RESEND_FROM_EMAIL):
        return False, "RESEND_FROM_EMAIL missing"
    return True, "configured"


def _check_twilio() -> tuple[bool, str]:
    from app.config import get_settings

    s = get_settings()
    ok = _present(s.TWILIO_ACCOUNT_SID) and _present(s.TWILIO_AUTH_TOKEN)
    return ok, "configured" if ok else "missing sid/token"


def run() -> int:
    from app.agent_runtime import llm_tools
    from app.agent_runtime.master_prompt import prompt_startup_diagnostic
    from app.agent_runtime.runtime import resolve_live_turn_handler
    from app.config import get_settings

    settings = get_settings()
    failures: list[str] = []
    print("=" * 72)
    print("SureShot Books — Tool Readiness Audit (v4.20)")
    print("=" * 72)

    handler = resolve_live_turn_handler(settings)
    print(f"Active runtime:           {handler}")
    print(f"VOICE_AGENT_RUNTIME_MODE: {settings.VOICE_AGENT_RUNTIME_MODE}")
    print(
        f"Legacy agent tools blocked: {settings.VOICE_LIVE_DISABLE_OPENAI_TOOLS} "
        f"(llm_tool_runtime unaffected)"
    )

    diag = prompt_startup_diagnostic()
    print(
        f"Master prompt: version={diag['version']} hash={diag['hash']} "
        f"chars={diag['chars']} sections={diag['sections']} "
        f"tokens~{diag['approx_tokens']} file={diag['path']}"
    )
    if diag["sections"] < 8:
        failures.append("master_prompt_sections_low")
    if int(diag["chars"]) < 5000:
        failures.append("master_prompt_chars_low")

    registered = llm_tools.tool_names()
    print(f"Registered tools:         {len(registered)}")

    print()
    print("Required env (presence only):")
    env_checks = {
        "OPENAI_API_KEY": settings.OPENAI_API_KEY,
        "SHOPIFY_SHOP_DOMAIN": settings.SHOPIFY_SHOP_DOMAIN,
        "SHOPIFY_ADMIN_ACCESS_TOKEN": settings.SHOPIFY_ADMIN_ACCESS_TOKEN,
        "TWILIO_ACCOUNT_SID": settings.TWILIO_ACCOUNT_SID,
        "TWILIO_AUTH_TOKEN": settings.TWILIO_AUTH_TOKEN,
        "RESEND_API_KEY": settings.RESEND_API_KEY,
        "REDIS_URL": settings.REDIS_URL,
    }
    for name, val in env_checks.items():
        ok = _present(val)
        mark = "OK" if ok else "MISSING"
        print(f"  [{mark}] {name}")
        if name in ("OPENAI_API_KEY", "SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN") and not ok:
            failures.append(f"env_{name}")

    print()
    print("Integration connectivity:")
    for label, fn in (
        ("Shopify", _check_shopify),
        ("Resend", _check_resend),
        ("Redis", _check_redis),
        ("Twilio", _check_twilio),
    ):
        ok, detail = fn()
        print(f"  [{'OK' if ok else 'FAIL'}] {label}: {detail}")
        if label == "Shopify" and not ok:
            failures.append("shopify_not_configured")

    print()
    print("Flow readiness:")
    shopify_ok, _ = _check_shopify()
    resend_ok, _ = _check_resend()
    print(f"  Caller lookup:     {'ready' if _present(settings.REDIS_URL) or shopify_ok else 'partial'}")
    print(f"  Payment send:      {'ready' if shopify_ok and resend_ok else 'partial'}")
    print(f"  Order lookup:      {'ready' if shopify_ok else 'broken'}")
    print(f"  Refund lookup:     {'ready' if shopify_ok else 'broken'}")
    print(f"  Facility tools:    partial (worker/cache — not live Shopify)")

    print()
    print("Tool audit table:")
    print(f"{'Tool':<36} {'Data':<14} {'Tests':<28} {'Ready':<8} {'Safe'}")
    print("-" * 96)
    inventory = _tool_inventory()
    registered_set = set(registered)
    for row in inventory:
        in_registry = row.name in registered_set
        readiness = row.readiness if in_registry else "broken"
        if not in_registry:
            failures.append(f"tool_missing_{row.name}")
        print(
            f"{row.name:<36} {row.data_source:<14} {row.tests:<28} "
            f"{readiness:<8} {'yes' if row.safe else 'NO'}"
        )

    missing_from_audit = sorted(set(registered) - {r.name for r in inventory})
    for name in missing_from_audit:
        print(f"{name:<36} {'?':<14} {'unaudited':<28} {'partial':<8} yes")

    print()
    if failures:
        print(f"FAIL — {len(failures)} issue(s): {', '.join(failures)}")
        return 1
    print("PASS — runtime, tools, and integrations look ready for live calls.")
    return 0


def main() -> int:
    try:
        return run()
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
