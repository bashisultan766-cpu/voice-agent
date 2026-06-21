"""Central latency budgets for the voice turn pipeline."""
from __future__ import annotations

from app.config import settings


def global_turn_timeout_secs() -> float:
    return settings.VOICE_TURN_GLOBAL_TIMEOUT_SECS


def intent_timeout_secs() -> float:
    return settings.VOICE_INTENT_TIMEOUT_SECS


def llm_timeout_secs() -> float:
    return settings.VOICE_LLM_TIMEOUT_SECS


def shopify_product_timeout_secs() -> float:
    return settings.VOICE_SHOPIFY_PRODUCT_TIMEOUT_SECS


def shopify_order_timeout_secs() -> float:
    return settings.VOICE_SHOPIFY_ORDER_TIMEOUT_SECS


def tts_timeout_secs() -> float:
    return settings.VOICE_TTS_TIMEOUT_SECS
