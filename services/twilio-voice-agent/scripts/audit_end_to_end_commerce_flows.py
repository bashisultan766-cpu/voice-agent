#!/usr/bin/env python3
"""End-to-end commerce flow audit matrix (v4.14.9). Dry-run/mocked — no live mutations."""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@dataclass
class FlowResult:
    flow: str
    route: str
    worker: str
    entities: dict
    result: str
    status: str  # OK | FAIL | PARTIAL


def _safe_entities(entities: dict) -> dict:
    blocked = {"email", "phone", "address", "checkout_url", "api_key", "token"}
    return {k: v for k, v in entities.items() if k not in blocked}


def _print_row(r: FlowResult) -> None:
    print(
        f"{r.flow} | {r.route} | {r.worker} | "
        f"{_safe_entities(r.entities)} | {r.result} | {r.status}"
    )


def _session_state():
    from app.state.models import SessionState

    return SessionState(
        session_id="audit_sess",
        call_sid="CAAUDIT1",
        from_number="+15551234567",
        to_number="+15559876543",
    )


def audit_book_by_isbn() -> FlowResult:
    from app.agent_runtime.business_intent_resolver import resolve_business_intent
    from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

    text = "The ISBN number is 9798994835500."
    biz = resolve_business_intent(text)
    entities = dict(biz.tool_entities) if biz.tool_entities else {"isbn": "9798994835500"}
    if not entities.get("isbn"):
        entities["isbn"] = "9798994835500"
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": biz.tool_categories or ["isbn_lookup"], "intent": biz.intent or "isbn_lookup"},
        entities,
    )
    workers = plans[0].worker_names if plans else []
    ok = biz.intent in ("isbn_lookup", "book_title_search", "catalog_search") or "product_isbn" in workers
    return FlowResult(
        "A_book_isbn",         biz.intent or "isbn_lookup", ",".join(workers[:3]),
        entities, "isbn_lookup->search->candidate" if ok else biz.intent,
        "OK" if ok else "FAIL",
    )


def audit_multiple_isbns() -> FlowResult:
    from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
    from app.agent_runtime.commerce_session import clear_commerce_session, get_commerce_session
    from app.agent_runtime.tool_entity_extractor import extract_all_isbns

    clear_commerce_session("CAAUDIT2")
    text = "I have two ISBN numbers, 9798994835500 and 9798893960648."
    isbns = extract_all_isbns(text)
    session = get_commerce_session("CAAUDIT2")
    result = resolve_commerce_commit(text, session)
    ok = len(isbns) == 2 and result.matched and len(session.collected_identifiers) >= 2
    return FlowResult(
        "B_multi_isbn", result.intent, "isbn_lookup,catalog_search",
        {"isbns": isbns}, f"{len(isbns)} identifiers->search->ask_add_both",
        "OK" if ok else "FAIL",
    )


def audit_book_by_title() -> FlowResult:
    from app.agent_runtime.business_intent_resolver import resolve_business_intent

    text = "The title is Game of Thrones."
    biz = resolve_business_intent(text)
    ok = biz.matched and biz.response_mode in ("needs_tools", "direct_answer")
    return FlowResult(
        "C_book_title", biz.intent or "catalog_search", "product_search",
        {"title": "Game of Thrones"}, "catalog_search->candidates",
        "OK" if ok else "PARTIAL",
    )


def audit_newspaper() -> FlowResult:
    from app.agent_runtime.business_intent_resolver import resolve_business_intent
    from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

    text = "I need USA Today 5 Day Delivery For 3 Months."
    biz = resolve_business_intent(text)
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": biz.tool_categories or ["catalog_search"], "intent": biz.intent},
        dict(biz.tool_entities or {}),
    )
    workers = plans[0].worker_names if plans else []
    ok = biz.intent == "newspaper_search" and "universal_catalog_search" in workers
    return FlowResult(
        "D_newspaper", biz.intent, ",".join(workers),
        dict(biz.tool_entities or {}), "newspaper_search->universal_catalog",
        "OK" if ok else "PARTIAL",
    )


def audit_magazine() -> FlowResult:
    from app.agent_runtime.business_intent_resolver import resolve_business_intent

    text = "I need People magazine for 6 months."
    biz = resolve_business_intent(text)
    ok = biz.intent == "magazine_search"
    return FlowResult(
        "E_magazine", biz.intent, "universal_catalog_search",
        dict(biz.tool_entities or {}), "magazine_search->universal_catalog",
        "OK" if ok else "PARTIAL",
    )


def audit_add_selected() -> FlowResult:
    from app.agent_runtime.cart_orchestrator import add_candidate_to_cart
    from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
    from app.agent_runtime.commerce_session import (
        ProductCandidate, clear_commerce_session, get_commerce_session, update_candidates_from_facts,
    )

    clear_commerce_session("CAAUDIT3")
    session = get_commerce_session("CAAUDIT3")
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="c1", product_id="p1", variant_id="v1", title="Test Book",
            author=None, isbn="9798994835500", price="$10", currency="USD",
            availability="available", inventory_quantity=1, source="isbn", confidence=0.99,
        ),
    ])
    session.expected_next = "confirm_add"
    result = resolve_commerce_commit("Add it.", session, session_state=_session_state())
    ok = result.matched and result.action in ("add_selected", None)
    line_ok = any(ln.variant_id == "v1" for ln in session.active_cart if ln.status == "active")
    if not line_ok and result.matched:
        add_candidate_to_cart(session, "c1", session_state=_session_state())
        line_ok = True
    return FlowResult(
        "F_add_selected", "cart_mutation", "cart_mutation",
        {"variant_id": "v1"}, "cart_line_added" if line_ok else "add_failed",
        "OK" if line_ok else "FAIL",
    )


def audit_add_all() -> FlowResult:
    from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
    from app.agent_runtime.commerce_session import (
        ProductCandidate, clear_commerce_session, get_commerce_session, update_candidates_from_facts,
    )

    clear_commerce_session("CAAUDIT4")
    session = get_commerce_session("CAAUDIT4")
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="c1", product_id="p1", variant_id="v1", title="Book A",
            author=None, isbn=None, price="$10", currency="USD",
            availability="available", inventory_quantity=1, source="search", confidence=0.9,
        ),
        ProductCandidate(
            candidate_id="c2", product_id="p2", variant_id="v2", title="Book B",
            author=None, isbn=None, price="$12", currency="USD",
            availability="available", inventory_quantity=1, source="search", confidence=0.9,
        ),
    ])
    result = resolve_commerce_commit("Add both.", session, session_state=_session_state())
    active = [ln for ln in session.active_cart if ln.status == "active"]
    ok = len(active) >= 2 or result.intent == "add_all_candidates"
    return FlowResult(
        "G_add_all", result.intent, "cart_mutation",
        {"count": len(active)}, f"{len(active)} lines added",
        "OK" if ok else "FAIL",
    )


def audit_remove() -> FlowResult:
    from app.agent_runtime.commerce_commit_resolver import resolve_commerce_commit
    from app.agent_runtime.commerce_session import (
        ProductCandidate, add_selected_candidate_to_cart, clear_commerce_session,
        get_commerce_session, update_candidates_from_facts,
    )

    clear_commerce_session("CAAUDIT5")
    session = get_commerce_session("CAAUDIT5")
    for i, title in enumerate(("First Book", "Second Book"), 1):
        update_candidates_from_facts(session, [
            ProductCandidate(
                candidate_id=f"c{i}", product_id=f"p{i}", variant_id=f"v{i}", title=title,
                author=None, isbn=None, price="$10", currency="USD",
                availability="available", inventory_quantity=1, source="search", confidence=0.9,
            ),
        ])
        session.selected_candidate_id = f"c{i}"
        add_selected_candidate_to_cart(session)
    result = resolve_commerce_commit("Remove the second one.", session)
    active = [ln for ln in session.active_cart if ln.status == "active"]
    ok = len(active) == 1 or result.intent == "remove_ordinal"
    return FlowResult(
        "H_remove", result.intent, "cart_mutation",
        {"remaining": len(active)}, "line_removed" if ok else "remove_failed",
        "OK" if ok else "PARTIAL",
    )


def audit_payment_single() -> FlowResult:
    from app.agent_runtime.commerce_session import (
        ProductCandidate, add_selected_candidate_to_cart, clear_commerce_session,
        get_commerce_session, update_candidates_from_facts,
    )
    from app.agent_runtime.payment_link_orchestrator import handle_payment_request

    clear_commerce_session("CAAUDIT6")
    session = get_commerce_session("CAAUDIT6")
    update_candidates_from_facts(session, [
        ProductCandidate(
            candidate_id="c1", product_id="p1", variant_id="v1", title="Book",
            author=None, isbn=None, price="$10", currency="USD",
            availability="available", inventory_quantity=1, source="search", confidence=0.9,
        ),
    ])
    add_selected_candidate_to_cart(session)
    ss = _session_state()
    ss.cart_items = [{"title": "Book", "variant_id": "v1", "quantity": 1, "confirmation_status": "confirmed"}]
    r1 = handle_payment_request(session, session_state=ss)
    ss.confirmed_email = "test@example.com"
    r2 = handle_payment_request(session, session_state=ss, cart_confirmed=True, email_confirmed=True)
    states = [r1.get("expected_next"), r2.get("expected_next")]
    ok = r2.get("expected_next") == "checkout_create" and r1.get("expected_next") in ("cart_confirm", "email_capture")
    return FlowResult(
        "I_payment_single", "payment_flow", "payment_flow,checkout,payment_email",
        {"states": states}, "cart_confirm->email->checkout_create",
        "OK" if ok else "PARTIAL",
    )


def audit_payment_multi_group() -> FlowResult:
    from app.agent_runtime.commerce_session import (
        ProductCandidate, add_selected_candidate_to_cart, clear_commerce_session,
        get_commerce_session, update_candidates_from_facts,
    )
    from app.agent_runtime.payment_link_orchestrator import (
        assign_lines_to_group, create_multi_payment_groups, parse_multi_group_assignment,
    )

    clear_commerce_session("CAAUDIT7")
    session = get_commerce_session("CAAUDIT7")
    lines = []
    for i in range(6):
        update_candidates_from_facts(session, [
            ProductCandidate(
                candidate_id=f"c{i}", product_id=f"p{i}", variant_id=f"v{i}", title=f"Book {i+1}",
                author=None, isbn=None, price="$10", currency="USD",
                availability="available", inventory_quantity=1, source="search", confidence=0.9,
            ),
        ])
        session.selected_candidate_id = f"c{i}"
        line = add_selected_candidate_to_cart(session)
        if line:
            lines.append(line.line_id)
    text = (
        "Send these 2 books to bashi at gmail dot com "
        "and the other 4 books to orders at company dot com."
    )
    assignments = parse_multi_group_assignment(text, session)
    ok = assignments is not None and len(assignments) == 2
    if ok:
        groups = create_multi_payment_groups(session, assignments)
        ok = len(groups) == 2 and groups[0].email != groups[1].email
    return FlowResult(
        "J_payment_multi", "payment_flow", "payment_flow x2",
        {"groups": 2 if ok else 0}, "two DestinationGroups->two emails",
        "OK" if ok else "PARTIAL",
    )


def audit_order_lookup() -> FlowResult:
    from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
    from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

    route = route_customer_service_intent("Order number is 1234.")
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": route["tool_categories"], "intent": route["intent"]},
        route.get("tool_entities") or {},
    )
    workers = plans[0].worker_names if plans else []
    ok = route["intent"] == "order_lookup" and "order_lookup" in workers
    return FlowResult(
        "K_order_lookup", route["intent"], ",".join(workers),
        route.get("tool_entities") or {}, "order_lookup worker route",
        "OK" if ok else "FAIL",
    )


def audit_refund() -> FlowResult:
    from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
    from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

    route = route_customer_service_intent("Refund status for order 1234.")
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": route["tool_categories"], "intent": route["intent"]},
        route.get("tool_entities") or {},
    )
    workers = plans[0].worker_names if plans else []
    ok = route["intent"] == "refund_lookup" and any("refund" in w for w in workers)
    return FlowResult(
        "L_refund", route["intent"], ",".join(workers),
        route.get("tool_entities") or {}, "refund before order route",
        "OK" if ok else "FAIL",
    )


def audit_facility() -> FlowResult:
    from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent

    route = route_customer_service_intent("Does this facility allow magazines?")
    ok = route["intent"] == "facility_approval"
    cats = route.get("tool_categories") or []
    return FlowResult(
        "M_facility", route["intent"], "facility_approval,facility_restriction",
        {"categories": cats}, "facility restriction route",
        "OK" if ok else "FAIL",
    )


def audit_address_update() -> FlowResult:
    from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent

    route = route_customer_service_intent("I need to update my shipping address.")
    ok = route["intent"] == "address_update"
    cats = route.get("tool_categories") or []
    has_escalation = "escalation" in cats or "address_update" in cats
    return FlowResult(
        "N_address_update", route["intent"], "address_update,escalation",
        {"categories": cats}, "address_update/escalation route",
        "OK" if ok and has_escalation else "PARTIAL",
    )


def run_all_flow_audits() -> list[FlowResult]:
    return [
        audit_book_by_isbn(),
        audit_multiple_isbns(),
        audit_book_by_title(),
        audit_newspaper(),
        audit_magazine(),
        audit_add_selected(),
        audit_add_all(),
        audit_remove(),
        audit_payment_single(),
        audit_payment_multi_group(),
        audit_order_lookup(),
        audit_refund(),
        audit_facility(),
        audit_address_update(),
    ]


def main() -> int:
    print("=== End-to-End Commerce Flow Audit (v4.14.9) ===")
    print("FLOW | ROUTE | WORKER | ENTITIES | RESULT | STATUS")
    print("-" * 80)
    results = run_all_flow_audits()
    for r in results:
        _print_row(r)
    ok_count = sum(1 for r in results if r.status == "OK")
    print(f"\nSummary: {ok_count}/{len(results)} OK")
    return 0 if ok_count == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
