"""FactPacket — normalized worker results for Final Composer (v4.11)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..workers.base import WorkerBundle


@dataclass
class FactPacket:
    customer_facing_facts: list[str] = field(default_factory=list)
    business_facts: dict[str, Any] = field(default_factory=dict)
    missing_fields: list[str] = field(default_factory=list)
    safe_response_hints: list[str] = field(default_factory=list)
    blocked_reasons: list[str] = field(default_factory=list)
    source_workers: list[str] = field(default_factory=list)
    sensitive_fields_masked: bool = True

    def to_composer_context(self) -> str:
        parts: list[str] = []
        if self.customer_facing_facts:
            parts.append("[Approved facts: " + "; ".join(self.customer_facing_facts[:20]) + "]")
        if self.safe_response_hints:
            parts.append("[Say: " + "; ".join(self.safe_response_hints[:5]) + "]")
        if self.missing_fields:
            parts.append("[Missing: " + ", ".join(self.missing_fields[:8]) + "]")
        if self.blocked_reasons:
            parts.append("[Blocked: " + "; ".join(self.blocked_reasons[:5]) + "]")
        for key, val in list(self.business_facts.items())[:12]:
            if isinstance(val, str) and val:
                parts.append(f"[{key}: {val[:120]}]")
        return "\n".join(parts)


def build_fact_packet(
    worker_bundle: "WorkerBundle",
    session=None,
) -> FactPacket:
    packet = FactPacket(source_workers=list(worker_bundle.workers_ran))

    for name, result in worker_bundle.results.items():
        if not result.success:
            if result.error_code:
                packet.blocked_reasons.append(f"{name}: {result.error_code}")
            continue
        if result.safe_summary:
            packet.customer_facing_facts.append(result.safe_summary[:200])
        if result.data:
            for k, v in result.data.items():
                if k in ("email", "phone", "address", "checkout_url"):
                    packet.sensitive_fields_masked = True
                    continue
                if isinstance(v, (str, int, float, bool)) and v:
                    packet.business_facts[f"{name}.{k}"] = str(v)[:200]

    if session is not None:
        plan = getattr(session, "response_plan", {}) or {}
        say = (plan.get("say") or "").strip()
        if say:
            packet.safe_response_hints.append(say)
        action = plan.get("action", "")
        if action:
            packet.business_facts["response_plan_action"] = action

        pfr = getattr(session, "payment_flow_result", {}) or {}
        if pfr.get("safe_message"):
            packet.safe_response_hints.insert(0, str(pfr["safe_message"]))
        if pfr.get("missing_fields"):
            packet.missing_fields.extend(pfr["missing_fields"])

    return packet
