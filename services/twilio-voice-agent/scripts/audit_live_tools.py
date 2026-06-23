#!/usr/bin/env python3
"""Dry-run audit of live tool routes (v4.14.8). No secrets printed."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _print_route_detail(label: str, intent: str, workers: list[str], entities: dict) -> None:
    safe_entities = {k: v for k, v in entities.items() if k not in ("email", "phone")}
    print(f"  {label}: intent={intent} workers={workers} entities={safe_entities}")


def main() -> int:
    from app.agent_runtime.tool_audit_runner import format_audit_report, run_all_audits
    from app.agent_runtime.business_intent_resolver import resolve_business_intent
    from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
    from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

    results = run_all_audits()
    print(format_audit_report(results))
    print("Route details:")

    biz = resolve_business_intent("I need a newspaper, like USA Today 5 day delivery for 3 months.")
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": biz.tool_categories, "intent": biz.intent}, dict(biz.tool_entities),
    )
    _print_route_detail("Newspaper", biz.intent, plans[0].worker_names if plans else [], biz.tool_entities)

    order = route_customer_service_intent("Order number is 1234")
    op = map_tool_categories_to_worker_intents(
        {"tool_categories": order.get("tool_categories", []), "intent": order.get("intent", "")},
        order.get("tool_entities") or {"order_number": "1234"},
    )
    _print_route_detail("Order", order.get("intent", ""), op[0].worker_names if op else [], order.get("tool_entities") or {})

    refund = route_customer_service_intent("Refund status for order 1234")
    rp = map_tool_categories_to_worker_intents(
        {"tool_categories": refund.get("tool_categories", []), "intent": refund.get("intent", "")},
        refund.get("tool_entities") or {},
    )
    _print_route_detail("Refund", refund.get("intent", ""), rp[0].worker_names if rp else [], refund.get("tool_entities") or {})

    facility = route_customer_service_intent("Does this facility allow newspapers?")
    fp = map_tool_categories_to_worker_intents(
        {"tool_categories": facility.get("tool_categories", []), "intent": facility.get("intent", "")},
        {},
    )
    _print_route_detail("Facility", facility.get("intent", ""), fp[0].worker_names if fp else [], {})

    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
