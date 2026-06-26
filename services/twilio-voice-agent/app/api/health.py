from fastapi import APIRouter, Depends

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    from ..config import get_settings
    from ..agent_runtime.live_runtime import resolve_live_turn_handler
    from ..agent_runtime.runtime_identity import collect_runtime_identity, validate_runtime_identity
    from ..state.session_store import get_redis_client

    s = get_settings()
    identity = collect_runtime_identity()
    failures = validate_runtime_identity(identity)

    redis_status = "not_configured"
    try:
        if s.REDIS_URL:
            client = await get_redis_client()
            if client is not None:
                await client.ping()
                redis_status = "ok"
            elif s.allow_memory_store_fallback:
                redis_status = "fallback_memory"
            else:
                redis_status = "unavailable"
    except Exception:
        redis_status = "error"

    return {
        "ok": not bool(failures) and redis_status in ("ok", "fallback_memory", "not_configured"),
        "status": "healthy" if not failures else "degraded",
        "service": "twilio-voice-agent",
        "app_env": s.APP_ENV,
        "runtime": "twilio_conversation_relay",
        "runtime_mode": s.VOICE_AGENT_RUNTIME_MODE,
        "live_turn_handler": resolve_live_turn_handler(s),
        "runtime_identity_ok": not bool(failures),
        "runtime_identity_failures": failures,
        "version": identity.get("voice_sales_flow_version"),
        "git_commit": identity.get("git_commit"),
        "git_branch": identity.get("git_branch"),
        "redis_status": redis_status,
        "shopify_configured": bool(s.SHOPIFY_SHOP_DOMAIN and s.SHOPIFY_ADMIN_ACCESS_TOKEN),
        "openai_configured": bool(s.OPENAI_API_KEY),
        "resend_configured": bool(s.RESEND_API_KEY and s.RESEND_FROM_EMAIL),
        "master_prompt_chars": identity.get("master_prompt_chars"),
        "voice_sales_flow_version": identity.get("voice_sales_flow_version"),
        "create_checkout_in_tool_specs": identity.get("create_checkout_present_in_tool_specs"),
        "welcome_greeting_enabled": s.VOICE_WELCOME_GREETING_ENABLED,
        "tts_provider": s.VOICE_TTS_PROVIDER,
        "voice_configured": bool(s.VOICE_ID) if s.VOICE_TTS_PROVIDER.lower() == "elevenlabs" else True,
        "memory_turns": s.VOICE_MEMORY_TURNS,
        "main_llm_timeout_ms": s.VOICE_MAIN_LLM_TIMEOUT_MS,
        "ws_token_validation_enabled": s.WS_TOKEN_VALIDATION_ENABLED,
        "api_docs_enabled": s.api_docs_enabled,
        "orchestrator_enabled": bool(getattr(s, "VOICE_ORCHESTRATOR_ENABLED", False)),
        "voice_commerce_runtime_enabled": bool(getattr(s, "VOICE_COMMERCE_RUNTIME_ENABLED", True)),
    }
