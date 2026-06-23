from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    from ..config import get_settings
    from ..agent_runtime.runtime import resolve_live_turn_handler
    s = get_settings()
    return {
        "ok": True,
        "service": "twilio-voice-agent",
        "runtime": "twilio_conversation_relay",
        "runtime_mode": s.VOICE_AGENT_RUNTIME_MODE,
        "live_turn_handler": resolve_live_turn_handler(s),
        "llm_brain_enabled": s.VOICE_LLM_BRAIN_ENABLED,
        "final_response_mode": s.VOICE_FINAL_RESPONSE_MODE,
        "welcome_greeting_enabled": s.VOICE_WELCOME_GREETING_ENABLED,
        "tts_provider": s.VOICE_TTS_PROVIDER,
        "voice_configured": bool(s.VOICE_ID) if s.VOICE_TTS_PROVIDER.lower() == "elevenlabs" else True,
        "memory_turns": s.VOICE_MEMORY_TURNS,
    }
