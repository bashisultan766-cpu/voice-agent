from __future__ import annotations
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field


class AgentCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=255)
    description: Optional[str] = None

    # Shopify
    shopify_store_url: Optional[str] = None
    shopify_api_key: Optional[str] = None  # plaintext; stored encrypted

    # LLM
    llm_provider: str = "openai"
    llm_model: str = "gpt-4o-mini"
    openai_api_key: Optional[str] = None  # plaintext; stored encrypted

    # Voice / TTS
    tts_provider: str = "openai"
    voice_id: str = "alloy"

    # Prompt
    system_prompt: Optional[str] = None

    # Twilio
    twilio_phone_number: Optional[str] = None

    # Tools
    enabled_tools: List[str] = [
        "product_search", "order_lookup", "checkout",
        "email", "customer_lookup", "recommendation",
    ]

    # Email
    from_email: Optional[str] = None
    resend_api_key: Optional[str] = None  # plaintext; stored encrypted


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    shopify_store_url: Optional[str] = None
    shopify_api_key: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    openai_api_key: Optional[str] = None
    tts_provider: Optional[str] = None
    voice_id: Optional[str] = None
    system_prompt: Optional[str] = None
    twilio_phone_number: Optional[str] = None
    enabled_tools: Optional[List[str]] = None
    from_email: Optional[str] = None
    resend_api_key: Optional[str] = None
    is_active: Optional[bool] = None


class AgentResponse(BaseModel):
    id: str
    tenant_id: str
    name: str
    description: Optional[str]
    is_active: bool
    shopify_store_url: Optional[str]
    llm_provider: str
    llm_model: str
    tts_provider: str
    voice_id: str
    system_prompt: str
    twilio_phone_number: Optional[str]
    enabled_tools: List[str]
    from_email: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
