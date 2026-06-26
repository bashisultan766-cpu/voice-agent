"""Deterministic dry-run audits for tool routes (v4.14.7)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class AuditResult:
    name: str
    ok: bool
    detail: str = ""


def _ok(name: str, detail: str = "") -> AuditResult:
    return AuditResult(name=name, ok=True, detail=detail)


def _fail(name: str, detail: str) -> AuditResult:
    return AuditResult(name=name, ok=False, detail=detail)


def audit_catalog_tools() -> AuditResult:
    from .business_intent_resolver import resolve_business_intent
    from .tool_category_mapper import map_tool_categories_to_worker_intents

    biz = resolve_business_intent("I need Dune by Frank Herbert")
    if not biz.matched or biz.response_mode != "needs_tools":
        return _fail("Catalog search", "book search not routed")
    entities = {"product_phrase": "Dune", "title": "Dune"}
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": ["catalog_search"], "intent": "book_title_search"},
        entities,
    )
    if not plans or not plans[0].worker_names:
        return _fail("Catalog search", "no worker plan")
    return _ok("Catalog search")


def audit_newspaper_search() -> AuditResult:
    from .business_intent_resolver import resolve_business_intent
    from .tool_category_mapper import map_tool_categories_to_worker_intents

    text = "I need a newspaper, like USA Today 5 day delivery for 3 months."
    biz = resolve_business_intent(text)
    if biz.intent != "newspaper_search" or biz.response_mode != "needs_tools":
        return _fail("Newspaper search", f"intent={biz.intent} mode={biz.response_mode}")
    entities = dict(biz.tool_entities)
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": biz.tool_categories, "intent": biz.intent},
        entities,
    )
    if not any("universal_catalog_search" in p.worker_names for p in plans):
        return _fail("Newspaper search", "universal_catalog_search not mapped")
    return _ok("Newspaper search")


def audit_magazine_search() -> AuditResult:
    from .business_intent_resolver import resolve_business_intent

    biz = resolve_business_intent("People magazine 6 months")
    if biz.intent != "magazine_search" or biz.response_mode != "needs_tools":
        return _fail("Magazine search", f"intent={biz.intent}")
    return _ok("Magazine search")


def audit_isbn_search() -> AuditResult:
    from .business_intent_resolver import resolve_business_intent

    biz = resolve_business_intent("ISBN is 9780441172719")
    if biz.intent != "isbn_lookup":
        return _fail("ISBN search", f"intent={biz.intent}")
    return _ok("ISBN search")


def audit_order_tools() -> AuditResult:
    from .customer_service_orchestrator import route_customer_service_intent

    route = route_customer_service_intent("Order number is 1234")
    if route.get("intent") != "order_lookup":
        return _fail("Order lookup routing", route.get("intent", ""))
    if route.get("response_mode") != "needs_tools":
        return _fail("Order lookup routing", "not needs_tools")
    ents = route.get("tool_entities") or {}
    if ents.get("order_number") != "1234":
        return _fail("Order lookup routing", "order_number missing")
    return _ok("Order lookup routing")


def audit_refund_tools() -> AuditResult:
    from .customer_service_orchestrator import route_customer_service_intent

    route = route_customer_service_intent("Refund status for order 1234")
    if route.get("intent") != "refund_lookup":
        return _fail("Refund lookup routing", route.get("intent", ""))
    if route.get("response_mode") != "needs_tools":
        return _fail("Refund lookup routing", "not needs_tools")
    return _ok("Refund lookup routing")


def audit_facility_tools() -> AuditResult:
    from .customer_service_orchestrator import route_customer_service_intent

    for phrase in (
        "Is Red Rock facility approved?",
        "Does this facility allow magazines?",
        "Does this facility allow newspapers?",
    ):
        route = route_customer_service_intent(phrase)
        if route.get("intent") != "facility_approval":
            return _fail("Facility lookup routing", f"{phrase!r} -> {route.get('intent')}")
    return _ok("Facility lookup routing")


def audit_cart_payment_tools() -> AuditResult:
    from .payment_link_orchestrator import handle_payment_request
    from .commerce_session import get_commerce_session, clear_commerce_session

    clear_commerce_session("audit_cart")
    cs = get_commerce_session("audit_cart")
    pay = handle_payment_request(cs)
    if "empty" not in (pay.get("message") or "").lower():
        return _fail("Cart add", "empty cart message unexpected")
    from ..workers.payment_safety_worker import PaymentSafetyWorker
    worker = PaymentSafetyWorker()
    if not hasattr(worker, "run"):
        return _fail("Payment safety", "worker missing")
    return _ok("Cart add", "empty cart OK")


def audit_payment_safety() -> AuditResult:
    from ..workers.payment_safety_worker import PaymentSafetyWorker

    worker = PaymentSafetyWorker()
    if worker.name != "payment_safety":
        return _fail("Payment safety", "worker name mismatch")
    return _ok("Payment safety")


def run_all_audits() -> list[AuditResult]:
    return [
        audit_catalog_tools(),
        audit_newspaper_search(),
        audit_magazine_search(),
        audit_isbn_search(),
        audit_order_tools(),
        audit_refund_tools(),
        audit_facility_tools(),
        audit_cart_payment_tools(),
        audit_payment_safety(),
    ]


def format_audit_report(results: list[AuditResult] | None = None) -> str:
    results = results or run_all_audits()
    lines = []
    for r in results:
        status = "OK" if r.ok else "FAIL"
        line = f"{r.name}: {status}"
        if r.detail and not r.ok:
            line += f" ({r.detail})"
        lines.append(line)
    return "\n".join(lines)
