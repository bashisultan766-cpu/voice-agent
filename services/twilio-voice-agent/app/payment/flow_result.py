"""Structured payment flow result (v4.4)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class PaymentFlowResult:
    ran: bool = True
    stage: str = "idle"
    allowed: bool = False
    missing_fields: list[str] = field(default_factory=list)
    checkout_created: bool = False
    email_sent: bool = False
    safe_message: str = ""
    masked_email: str = ""
    cart_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "ran": self.ran,
            "stage": self.stage,
            "allowed": self.allowed,
            "missing_fields": list(self.missing_fields),
            "checkout_created": self.checkout_created,
            "email_sent": self.email_sent,
            "safe_message": self.safe_message,
            "masked_email": self.masked_email,
            "cart_count": self.cart_count,
        }
