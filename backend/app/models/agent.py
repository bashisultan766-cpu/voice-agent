from __future__ import annotations
import uuid
from datetime import datetime
from typing import Any
from sqlalchemy import String, Boolean, DateTime, Text, JSON, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

DEFAULT_TOOLS = [
    "product_search",
    "order_lookup",
    "checkout",
    "email",
    "customer_lookup",
    "recommendation",
]

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful AI sales assistant for an online store. "
    "Help customers find products, check orders, and complete purchases. "
    "Be friendly, concise, and focused on helping the customer. "
    "Always collect the customer's email before sending a payment link."
)


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    tenant_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Shopify credentials (encrypted at application layer)
    shopify_store_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    shopify_api_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    # LLM config
    llm_provider: Mapped[str] = mapped_column(String(50), default="openai")
    llm_model: Mapped[str] = mapped_column(String(100), default="gpt-4o-mini")
    openai_api_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    # TTS / Voice config
    tts_provider: Mapped[str] = mapped_column(String(50), default="openai")
    voice_id: Mapped[str] = mapped_column(String(100), default="alloy")

    # System prompt
    system_prompt: Mapped[str] = mapped_column(Text, default=DEFAULT_SYSTEM_PROMPT)

    # Twilio
    twilio_phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Tool configuration (list of enabled tool names)
    enabled_tools: Mapped[list[Any]] = mapped_column(JSON, default=lambda: DEFAULT_TOOLS)

    # Email config (per-agent override)
    from_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    resend_api_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    tenant: Mapped["Tenant"] = relationship("Tenant", back_populates="agents")  # noqa: F821
    call_logs: Mapped[list["CallLog"]] = relationship(  # noqa: F821
        "CallLog", back_populates="agent"
    )
