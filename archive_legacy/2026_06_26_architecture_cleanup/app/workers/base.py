"""
Base types shared across all workers.

WorkerResult — structured output from one async worker.
WorkerBundle — aggregated bundle passed to MainLLMComposer.

Security constraints enforced here:
- to_llm_context() produces a compact, safe string (no raw Shopify JSON,
  no full emails, no GIDs, no payment card data).
- Sensitive worker results are gated behind verified_email / verified_phone.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class WorkerResult:
    """
    Structured result from one deterministic async worker.

    Attributes
    ----------
    worker_name : str
        Unique worker identifier (e.g. "product_isbn", "order_lookup").
    success : bool
        True when the worker completed its task (cache hit, Shopify call, etc.).
    data : dict
        Structured, safe payload — never raw Shopify JSON, never full emails.
    safe_summary : str
        Short, voice-ready phrase the composer may use directly.
    requires_verification : bool
        When True, full data must not reach the caller until
        verified_email or verified_phone is True on the session.
    error_code : str or None
        Machine-readable failure reason when success=False.
    latency_ms : float
        Wall time for this worker's execution.
    source : str
        Where the data originated: "cache" | "shopify" | "resend" | "local" | "none".
    """

    worker_name: str
    success: bool
    data: dict = field(default_factory=dict)
    safe_summary: str = ""
    requires_verification: bool = False
    error_code: Optional[str] = None
    latency_ms: float = 0.0
    source: str = "none"


@dataclass
class WorkerBundle:
    """
    Aggregated results from all workers that ran for one pipeline turn.

    Passed to MainLLMComposer which uses it to compose a single voice response.
    """

    workers_ran: list[str] = field(default_factory=list)
    results: dict[str, WorkerResult] = field(default_factory=dict)
    total_ms: float = 0.0
    # Max latency from workers that hit Shopify/Resend — surfaced to TurnLatency.
    shopify_api_ms: float = 0.0
    resend_api_ms: float = 0.0

    def get(self, worker_name: str) -> Optional[WorkerResult]:
        return self.results.get(worker_name)

    def successful(self) -> list[WorkerResult]:
        return [r for r in self.results.values() if r.success]

    def to_llm_context(
        self,
        verified_email: bool = False,
        verified_phone: bool = False,
    ) -> str:
        """
        Build a compact, safe context block for MainLLMComposer.

        Enforced rules:
        - No raw Shopify JSON, GIDs, or full order objects.
        - No full email addresses.
        - No payment card or address data.
        - Workers marked requires_verification are gated unless caller is verified.
        - Failed workers noted briefly only if error is actionable.
        """
        verified = verified_email or verified_phone
        lines = ["[WORKER DATA — fetched before LLM call, no live Shopify JSON]"]

        for name, result in self.results.items():
            if not result.success:
                if result.error_code and result.error_code not in (
                    "not_configured", "no_isbn", "no_query", "no_order_number", "no_email", "no_items"
                ):
                    lines.append(f"{name}: temporarily unavailable")
                continue

            if result.requires_verification and not verified:
                lines.append(
                    f"{name}: data available but requires caller verification "
                    "(ask for email or phone before sharing)"
                )
                continue

            if result.safe_summary:
                lines.append(f"{name}: {result.safe_summary}")

        if len(lines) == 1:
            lines.append("No worker data is available for this turn.")

        return "\n".join(lines)
