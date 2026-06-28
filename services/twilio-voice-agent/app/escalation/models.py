"""Structured escalation payloads."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Optional

RequestedType = Literal[
    "isbn", "title", "author", "newspaper", "magazine", "product", "unknown"
]


@dataclass
class ProductNotFoundEscalationPayload:
    session_id: str
    call_sid: str
    customer_phone: str = ""
    customer_name: str = ""
    customer_email: str = ""
    requested_type: RequestedType = "unknown"
    requested_value: str = ""
    quantity: Optional[int] = None
    facility_name: str = ""
    conversation_summary: str = ""
    last_search_results: dict[str, Any] = field(default_factory=dict)
    reason: str = "product_not_found"
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ProductNotFoundEscalationPayload":
        return cls(
            session_id=str(data.get("session_id") or ""),
            call_sid=str(data.get("call_sid") or ""),
            customer_phone=str(data.get("customer_phone") or ""),
            customer_name=str(data.get("customer_name") or ""),
            customer_email=str(data.get("customer_email") or ""),
            requested_type=data.get("requested_type") or "unknown",
            requested_value=str(data.get("requested_value") or ""),
            quantity=data.get("quantity"),
            facility_name=str(data.get("facility_name") or ""),
            conversation_summary=str(data.get("conversation_summary") or ""),
            last_search_results=dict(data.get("last_search_results") or {}),
            reason=str(data.get("reason") or "product_not_found"),
            created_at=str(data.get("created_at") or ""),
        )

    def idempotency_key(self) -> str:
        normalized = (self.requested_value or "").strip().lower()
        return f"{self.call_sid}:{self.requested_type}:{normalized}"


QueryType = Literal[
    "order", "product", "refund", "facility", "shipping", "general", "unknown",
    "isbn", "title", "author", "newspaper", "magazine",
]


@dataclass
class CustomerQueryEscalationPayload:
    """Escalate an unresolved voice query to the SureShot backend team."""

    session_id: str
    call_sid: str
    customer_phone: str = ""
    customer_name: str = ""
    customer_email: str = ""
    query_type: str = "general"
    issue_title: str = ""
    issue_detail: str = ""
    conversation_summary: str = ""
    conversation_transcript: str = ""
    api_context: dict[str, Any] = field(default_factory=dict)
    reason: str = "unresolved_customer_query"
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CustomerQueryEscalationPayload":
        return cls(
            session_id=str(data.get("session_id") or ""),
            call_sid=str(data.get("call_sid") or ""),
            customer_phone=str(data.get("customer_phone") or ""),
            customer_name=str(data.get("customer_name") or ""),
            customer_email=str(data.get("customer_email") or ""),
            query_type=str(data.get("query_type") or "general"),
            issue_title=str(data.get("issue_title") or ""),
            issue_detail=str(data.get("issue_detail") or ""),
            conversation_summary=str(data.get("conversation_summary") or ""),
            conversation_transcript=str(data.get("conversation_transcript") or ""),
            api_context=dict(data.get("api_context") or {}),
            reason=str(data.get("reason") or "unresolved_customer_query"),
            created_at=str(data.get("created_at") or ""),
        )

    def idempotency_key(self) -> str:
        import hashlib

        raw = (
            f"{self.call_sid}:{self.query_type}:"
            f"{(self.issue_title or '').strip().lower()}:"
            f"{(self.issue_detail or '').strip().lower()[:120]}"
        )
        return hashlib.sha256(raw.encode()).hexdigest()[:32]
