"""PaymentSafetyWorker — deterministic payment flow gatekeeper."""
from __future__ import annotations
import time
from .base import WorkerResult


class PaymentSafetyWorker:
    name = "payment_safety"

    async def run(self, session, entities, settings) -> WorkerResult:
        t0 = time.monotonic()
        pfs = getattr(session, "payment_flow_status", "idle") or "idle"
        cart = getattr(session, "cart_items", []) or []
        confirmed_cart = [
            c for c in cart
            if isinstance(c, dict)
            and c.get("confirmation_status") == "confirmed"
        ]
        has_book = bool(
            confirmed_cart
            or session.last_product_title
            or any(
                isinstance(c, dict) and c.get("confirmation_status") != "rejected"
                for c in cart
            )
        )
        has_email = bool(getattr(session, "confirmed_email", ""))

        if pfs == "payment_sent":
            return WorkerResult(
                worker_name=self.name,
                success=True,
                data={"status": "already_sent", "missing": []},
                safe_summary="Payment link already sent this call.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        missing = []
        if not has_book:
            missing.append("book")
        if not has_email:
            missing.append("confirmed_email")

        if missing:
            return WorkerResult(
                worker_name=self.name,
                success=False,
                error_code="missing_fields",
                data={"missing": missing, "pfs": pfs},
                safe_summary=f"Payment blocked: missing {', '.join(missing)}.",
                latency_ms=(time.monotonic() - t0) * 1000,
                source="local",
            )

        return WorkerResult(
            worker_name=self.name,
            success=True,
            data={"status": "ready", "missing": [], "pfs": pfs},
            safe_summary="Payment flow ready.",
            latency_ms=(time.monotonic() - t0) * 1000,
            source="local",
        )
