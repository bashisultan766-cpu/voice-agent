import time
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class ConversationState(str, Enum):
    IDLE = "IDLE"
    PRODUCT_SEARCH = "PRODUCT_SEARCH"
    PRODUCT_CONFIRMED = "PRODUCT_CONFIRMED"
    EMAIL_COLLECTING = "EMAIL_COLLECTING"
    EMAIL_CONFIRMING = "EMAIL_CONFIRMING"
    EMAIL_CONFIRMED = "EMAIL_CONFIRMED"
    CHECKOUT_CREATING = "CHECKOUT_CREATING"
    CHECKOUT_SENT = "CHECKOUT_SENT"
    ESCALATED = "ESCALATED"
    CLOSING = "CLOSING"


class EmailFSMState(str, Enum):
    NONE = "NONE"
    COLLECTING = "COLLECTING"
    CONFIRMING = "CONFIRMING"
    CONFIRMED = "CONFIRMED"
    REJECTED = "REJECTED"
    MAX_RETRIES = "MAX_RETRIES"


class HistoryEntry(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class SessionState(BaseModel):
    session_id: str
    agent_id: str
    tenant_id: str
    call_sid: str
    from_number: str
    to_number: str

    # Conversation flow
    conversation_state: ConversationState = ConversationState.IDLE
    email_fsm_state: EmailFSMState = EmailFSMState.NONE

    # Product selection
    selected_product: Optional[dict[str, Any]] = None
    selected_variant_id: Optional[str] = None
    quantity: int = 1

    # Email capture
    customer_email: Optional[str] = None
    email_pending_confirm: Optional[str] = None
    email_retry_count: int = 0

    # Checkout
    checkout_link_id: Optional[str] = None

    # Caller context
    caller_name: Optional[str] = None
    language: str = "en"

    # History (last 10 exchanges = 20 entries)
    history: list[HistoryEntry] = Field(default_factory=list)
    turn_count: int = 0

    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)

    def add_turn(self, user_message: str, assistant_message: str) -> None:
        self.history.append(HistoryEntry(role="user", content=user_message))
        self.history.append(HistoryEntry(role="assistant", content=assistant_message))
        if len(self.history) > 20:
            self.history = self.history[-20:]
        self.turn_count += 1
        self.updated_at = time.time()

    def to_openai_messages(self) -> list[dict[str, str]]:
        return [{"role": e.role, "content": e.content} for e in self.history]
