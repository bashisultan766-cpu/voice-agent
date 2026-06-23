#!/usr/bin/env python3
"""Debug order lookup route (v4.14.8). No PII, no mutations."""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


async def _dry_run_order_lookup(order_number: str) -> dict:
    from app.agent_runtime.customer_service_orchestrator import route_customer_service_intent
    from app.agent_runtime.tool_category_mapper import map_tool_categories_to_worker_intents

    phrase = f"Order number is {order_number}"
    route = route_customer_service_intent(phrase)
    entities = dict(route.get("tool_entities") or {})
    entities.setdefault("order_number", order_number)
    plans = map_tool_categories_to_worker_intents(
        {"tool_categories": route.get("tool_categories", []), "intent": route.get("intent", "")},
        entities,
    )
    worker_names = plans[0].worker_names if plans else []
    worker = "order_lookup" if "order_lookup" in worker_names else (worker_names[0] if worker_names else "none")

    result_status = "not_found"
    with patch("app.workers.order_lookup_worker.OrderLookupWorker.run", new=AsyncMock(return_value=type("R", (), {
        "success": True, "data": {"not_found": True}, "worker_name": "order_lookup",
    })())):
        from app.workers.order_lookup_worker import OrderLookupWorker
        from app.state.models import SessionState

        state = SessionState(session_id="dbg", call_sid="CAorderdbg", from_number="+1", to_number="+2")
        wr = await OrderLookupWorker().run(state, entities, settings=None)
        if wr.data and wr.data.get("status"):
            result_status = "found"

    return {
        "intent": route.get("intent"),
        "worker": worker,
        "entities": {"order_number": order_number},
        "result": result_status,
        "status": "OK" if route.get("intent") == "order_lookup" else "FAIL",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--order", default="1234")
    args = parser.parse_args()

    info = asyncio.run(_dry_run_order_lookup(args.order))
    print("Order lookup route:")
    print(f"intent={info['intent']}")
    print(f"worker={info['worker']}")
    print(f"entities={info['entities']}")
    print(f"result={info['result']}")
    print(f"status={info['status']}")
    return 0 if info["status"] == "OK" else 1


if __name__ == "__main__":
    raise SystemExit(main())
