#!/usr/bin/env python3
"""Safe payment flow dry-run — no real email unless PAYMENT_SMOKE_SEND=1."""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings
from app.state.models import SessionState
from app.workers.payment_flow_worker import PaymentFlowWorker


async def main() -> None:
    settings = Settings(OPENAI_API_KEY="test", DEBUG=True)
    session = SessionState(
        session_id="smoke", call_sid="CA_SMOKE",
        from_number="+15551234567", to_number="+18005551234",
        confirmed_email="test@example.com",
        payment_flow_status="awaiting_send_confirmation",
    )
    session.cart_items = [{
        "title": "Smoke Book", "variant_id": "gid://shopify/Variant/1",
        "quantity": 1, "confirmation_status": "confirmed",
    }]
    worker = PaymentFlowWorker()
    if os.environ.get("PAYMENT_SMOKE_SEND") != "1":
        print("DRY-RUN: PaymentFlowWorker structure only (set PAYMENT_SMOKE_SEND=1 for live)")
        r = await worker.run(session, {"intent": "send_payment_link"}, settings)
        print("stage=", r.data.get("stage"), "allowed=", r.data.get("allowed"))
        print("missing=", r.data.get("missing_fields"))
        return
    r = await worker.run(session, {"intent": "send_payment_link"}, settings)
    print("result:", r.data)


if __name__ == "__main__":
    asyncio.run(main())
