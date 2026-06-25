from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    from ..config import get_settings
    from ..agent_runtime.runtime import resolve_live_turn_handler
    from ..agent_runtime.runtime_identity import collect_runtime_identity, validate_runtime_identity

    s = get_settings()
    identity = collect_runtime_identity()
    failures = validate_runtime_identity(identity)
    return {
        "ok": True and not failures,
        "service": "twilio-voice-agent",
        "runtime": "twilio_conversation_relay",
        "runtime_mode": s.VOICE_AGENT_RUNTIME_MODE,
        "live_turn_handler": resolve_live_turn_handler(s),
        "runtime_identity_ok": not bool(failures),
        "runtime_identity_failures": failures,
        "git_commit": identity.get("git_commit"),
        "git_branch": identity.get("git_branch"),
        "master_prompt_chars": identity.get("master_prompt_chars"),
        "voice_sales_flow_version": identity.get("voice_sales_flow_version"),
        "create_checkout_in_tool_specs": identity.get("create_checkout_present_in_tool_specs"),
        "llm_brain_enabled": s.VOICE_LLM_BRAIN_ENABLED,
        "final_response_mode": s.VOICE_FINAL_RESPONSE_MODE,
        "welcome_greeting_enabled": s.VOICE_WELCOME_GREETING_ENABLED,
        "tts_provider": s.VOICE_TTS_PROVIDER,
        "voice_configured": bool(s.VOICE_ID) if s.VOICE_TTS_PROVIDER.lower() == "elevenlabs" else True,
        "memory_turns": s.VOICE_MEMORY_TURNS,
        "main_llm_timeout_ms": s.VOICE_MAIN_LLM_TIMEOUT_MS,
    }
